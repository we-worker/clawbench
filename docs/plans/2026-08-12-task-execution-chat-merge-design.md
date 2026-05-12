# Scheduled Task Execution → Chat Storage Merge Design

**Date:** 2026-08-12
**Status:** Implemented

## Goal

Merge `task_executions` storage into the `chat_sessions` + `chat_history` system to eliminate duplicate data models, reduce code, and unify content rendering.

## Current State

- `task_executions` table: `(id, task_id, content, trigger_type, created_at)` — stores execution results as a self-contained JSON blob
- `chat_history` / `chat_sessions`: stores interactive chat messages
- Both use identical `{blocks: [...], metadata: {...}}` content format
- Task executions have no streaming support, no soft-delete, no RAG indexing
- Code comment confirms: `// Record execution directly in task_executions (no longer writes to chat_history)`

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Merge strategy | Execution = chat messages | Unified data model, one CRUD path |
| Session granularity | One execution = one chat_session | Each execution independently deletable, RAG-indexable, future-streamable |
| Association mechanism | `chat_sessions.session_type` + thin `task_executions` table | chat_sessions gets only a type column; task_executions becomes a join table |
| Streaming | Not in this iteration | Incremental approach; storage merge first, streaming later |
| Delete strategy | Cascade delete | Delete task → soft-delete chat_sessions → delete task_executions rows |
| Migration | One-time manual CLI command, no backward compatibility | Code only knows new schema; `clawbench migrate` handles old data |

## Schema Changes

### chat_sessions — add column

```sql
-- In CREATE TABLE statement, add:
session_type TEXT NOT NULL DEFAULT 'chat',
-- Values: 'chat' (interactive) | 'scheduled' (task execution)
```

New index:
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_type ON chat_sessions(session_type, project_path, deleted);
```

**Note:** `chat_sessions.last_read_at` is unused for `session_type='scheduled'` sessions. Unread tracking for executions uses `scheduled_tasks.last_read_at` instead.

### task_executions — new schema

```sql
-- Old: (id INTEGER PK, task_id TEXT, content TEXT, trigger_type TEXT, created_at DATETIME)
-- New:
CREATE TABLE IF NOT EXISTS task_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,        -- FK to chat_sessions.id
    trigger_type TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'completed',  -- 'completed' | 'cancelled' | 'failed'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON task_executions(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_session ON task_executions(session_id);
```

**Why `status` column:** Cancelled executions leave a session + user message but no assistant message. Without `status`, the frontend cannot distinguish completed from cancelled from failed. Makes execution outcomes queryable without parsing content.

### chat_history — no changes

### scheduled_tasks — no changes

**Note:** `scheduled_tasks.session_id` is an existing column that links a task to the chat session where it was *created* (when the AI uses `clawbench task create` during an interactive chat). This is unrelated to the execution sessions tracked via `task_executions.session_id`. Do not confuse the two.

## Relationship Chain

```
scheduled_tasks ←(task_id)→ task_executions ←(session_id)→ chat_sessions ←(session_id)→ chat_history
```

## Message Write Flow

### executeTask() rewrite (scheduler.go:343-525)

**On execution start:**
1. Create `chat_session` via `CreateSession()` with:
   - `session_type = 'scheduled'` (new parameter)
   - `title` = task name
   - `backend` = resolved from task's agent_id
   - `agent_id` = task's agent_id
2. Insert `task_executions` row: `(task_id, session_id, trigger_type, status='completed')` — optimistic; updated on cancel/failure
3. Write `role='user'` message via `AddChatMessage()`: content = task prompt, `files` = `@path` references

**On execution complete (replaces lines 469-478):**
4. Write `role='assistant'` message via `AddChatMessage()`: content = `{blocks: [...], metadata: {...}}` — identical format to interactive chat
5. Update `scheduled_tasks` stats (run_count, last_run_at, next_run_at, status) — unchanged logic

**On execution failure:**
- Write `role='assistant'` message with error/warning blocks
- Update `task_executions.status = 'failed'`

**On execution cancellation (replaces lines 452-458):**
- Instead of skipping persistence entirely, update `task_executions.status = 'cancelled'`
- Omit assistant message (no output was produced)
- Still update `scheduled_tasks` stats (increment run_count, update last_run_at)

## Query Changes

### All existing session queries must filter by session_type

Every query that lists/filters chat sessions for the interactive UI must add `AND session_type = 'chat'`:

| Function | File:Line | Change |
|---|---|---|
| `GetSessions()` | chat.go:251 | Add `AND session_type = 'chat'` |
| `GetSessionCount()` | chat.go:349 | Add `AND session_type = 'chat'` |

**Queries that should NOT filter by session_type:**
- `GetExpiredDeletedSessions()` (chat.go:499) — CleanupWorker handles both types
- `GetChatHistoryPaged()` (chat.go:22) — already filtered by session_id, not affected
- `GetSessionBackend()`, `GetSessionModel()`, `GetSessionTitle()`, `GetSessionAgentID()` — lookup by ID, not affected
- `HasUnreadTasks()` — queries `task_executions`, not `chat_sessions`

### GET /api/tasks/{id}/executions (handler/scheduler.go:237-285)

Replace current N+1 pattern with single JOIN query:

```sql
SELECT te.session_id, te.trigger_type, te.status, te.created_at,
       ch.content AS assistant_content
FROM task_executions te
LEFT JOIN chat_history ch ON ch.session_id = te.session_id
    AND ch.role = 'assistant'
    AND ch.deleted = 0
    AND ch.streaming = 0
WHERE te.task_id = ?
ORDER BY te.created_at DESC
```

LEFT JOIN handles cancelled executions with no assistant message.

Replace inline `Execution` struct (line 244-248):
```go
type Execution struct {
    SessionID   string  `json:"sessionId"`
    TriggerType string  `json:"triggerType"`
    Status      string  `json:"status"`
    Content     *string `json:"content"`      // nil for cancelled executions
    CreatedAt   string  `json:"createdAt"`
    IsUnread    bool    `json:"isUnread"`
}
```

### Unread count queries

`GetTasks()` / `GetTaskByID()` / `HasUnreadTasks()` — query `task_executions.created_at` against `scheduled_tasks.last_read_at`. Logic unchanged since `created_at` column remains.

## Delete & Cleanup

### Delete task (handler/scheduler.go:224-228)

Current code only calls `CancelAllExecutions()` + `RemoveTask()`. Enhance to:

1. `CancelAllExecutions(taskID)` — kill running processes
2. Query `task_executions` for all `session_id` values where `task_id = ?`
3. For each `session_id`: call `DeleteSession()` (soft-deletes `chat_sessions` + `chat_history`)
4. Delete all `task_executions` rows for this task
5. Call `RemoveTask(taskID)` — marks `scheduled_tasks` as deleted

### Delete single execution

Not currently supported by API. The data model now makes it trivial: delete `task_executions` row + soft-delete the associated `chat_session`.

### CleanupWorker (rag/cleanup.go)

In `PurgeDeletedData()` (chat.go:520-563), after deleting `chat_sessions`, also delete associated `task_executions` rows:

```go
// After deleting chat_sessions, clean up task_executions for scheduled sessions
_, _ = tx.Exec("DELETE FROM task_executions WHERE session_id IN ("+placeholders+")", args...)
```

This is safe: if the session was `session_type='chat'`, there are no matching `task_executions` rows. If `session_type='scheduled'`, the join table row is cleaned up.

## CreateSession() Signature Change

Current signature (chat.go:319):
```go
func CreateSession(projectPath, backend, title, agentID, modelName, agentSource string) (string, error)
```

New signature:
```go
func CreateSession(projectPath, backend, title, agentID, modelName, agentSource, sessionType string) (string, error)
```

Callers:
- **Interactive chat** (handler/chat_session.go, handler/chat.go): pass `"chat"`
- **Scheduled execution** (scheduler.go `executeTask()`): pass `"scheduled"`

The INSERT statement adds `session_type` column.

## ChatSession Model Change

```go
// model/chat.go — add field:
type ChatSession struct {
    // ... existing fields ...
    SessionType string     `json:"sessionType,omitempty"` // "chat" (interactive) | "scheduled" (task execution)
}
```

`GetSessions()` query adds `session_type` to SELECT list and scan.

## Migration

### `clawbench migrate` subcommand

One-time manual CLI command. **Must be run on the OLD binary before deploying the new code.**

**Operation:**
1. Reads all `task_executions` rows where `content != ''`
2. For each row (in a transaction):
   - Look up `scheduled_tasks` to get task name, agent_id, prompt, project_path
   - If task not found (deleted), skip with warning
   - Create `chat_session` (`session_type='scheduled'`, title=task name, backend/agent_id from task)
   - Write `role='user'` message (content = task prompt)
   - If `content` is non-empty: write `role='assistant'` message (content = existing JSON)
   - Update `task_executions` row: set `session_id`
3. After all rows migrated, report count

**Idempotency:** The `session_id` column doesn't exist in the old schema, so the old binary can't set it. Instead, the migrate command tracks migrated IDs by checking if a `chat_session` already exists with a matching `task_id` metadata tag. **Simpler approach:** since this is a one-time manual command, just don't run it twice. Log the count and stop.

**Deployment procedure:**
1. Stop the server
2. Run `./clawbench-old migrate` (migrates content data into chat tables)
3. Deploy new binary
4. Start the server (new code auto-applies schema changes via `CREATE TABLE IF NOT EXISTS`)

**Note:** The migrate command must call `InitDB()` (without `runFromServer`) to get DB access, then directly execute SQL. It does NOT need the server running — it operates on the SQLite file directly. However, the old binary doesn't have a `migrate` subcommand. **Alternative:** provide the migration as a standalone SQL script + a small Go program, or build the migrate command into the NEW binary and have it detect old-schema `task_executions` (has `content` column but no `session_id`).

**Recommended approach:** Build `clawbench migrate` into the NEW binary. On startup, if `task_executions` has `content` column but no `session_id`, auto-detect and log a warning. The `clawbench migrate` command then:
1. Detects old schema (`pragma_table_info` check)
2. Migrates data: for each `task_executions` row with `content`, create session + messages
3. Applies new schema: rename old table → create new → copy data → drop old

This way only one binary is needed, and the migration is a conscious step (not automatic).

### Migration implementation sketch

```go
func runMigrate() {
    loadConfig()
    service.InitDB()

    // Check if migration is needed
    var hasContent, hasSessionID bool
    service.DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('task_executions') WHERE name='content'").Scan(&hasContent)
    service.DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('task_executions') WHERE name='session_id'").Scan(&hasSessionID)

    if !hasContent || hasSessionID {
        fmt.Println("No migration needed — schema is already up to date.")
        return
    }

    // Also ensure chat_sessions has session_type column
    var hasSessionType bool
    service.DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name='session_type'").Scan(&hasSessionType)
    if !hasSessionType {
        service.DB.Exec("ALTER TABLE chat_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'chat'")
    }

    // Migrate each execution
    rows, _ := service.DB.Query("SELECT id, task_id, content, trigger_type, created_at FROM task_executions WHERE content != ''")
    defer rows.Close()

    migrated := 0
    for rows.Next() {
        var id int64
        var taskID, content, triggerType, createdAt string
        rows.Scan(&id, &taskID, &content, &triggerType, &createdAt)

        // Look up task for metadata
        var taskName, agentID, prompt, projectPath string
        var backend string
        err := service.DB.QueryRow(
            "SELECT name, agent_id, prompt, project_path FROM scheduled_tasks WHERE id = ?", taskID,
        ).Scan(&taskName, &agentID, &prompt, &projectPath)
        if err != nil {
            fmt.Fprintf(os.Stderr, "  skipping exec %d: task %s not found\n", id, taskID)
            continue
        }

        // Resolve backend from agent
        if agent, ok := model.Agents[agentID]; ok && agent.Backend != "" {
            backend = agent.Backend
        } else {
            backend = "codebuddy"
        }

        // Create session
        sessionID, err := service.CreateSession(projectPath, backend, taskName, agentID, "", "default", "scheduled")
        if err != nil {
            fmt.Fprintf(os.Stderr, "  skipping exec %d: failed to create session: %v\n", id, err)
            continue
        }

        // Write user message
        service.AddChatMessage(projectPath, backend, sessionID, "user", prompt, nil, false, taskName)

        // Write assistant message (if content exists)
        if content != "" {
            service.AddChatMessage(projectPath, backend, sessionID, "assistant", content, nil, false, "")
        }

        migrated++
    }

    fmt.Printf("Migrated %d executions.\n", migrated)

    // Apply new schema
    service.DB.Exec("ALTER TABLE task_executions RENAME TO task_executions_old")
    service.DB.Exec(`CREATE TABLE task_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL DEFAULT 'completed',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    service.DB.Exec(`INSERT INTO task_executions (id, task_id, session_id, trigger_type, status, created_at)
        SELECT te.id, te.task_id,
               COALESCE(cs.id, ''),
               te.trigger_type, 'completed', te.created_at
        FROM task_executions_old te
        LEFT JOIN chat_sessions cs ON cs.title = (SELECT name FROM scheduled_tasks WHERE id = te.task_id)
            AND cs.session_type = 'scheduled'
            AND cs.project_path = (SELECT project_path FROM scheduled_tasks WHERE id = te.task_id)`)
    service.DB.Exec("DROP TABLE task_executions_old")
    service.DB.Exec("CREATE INDEX IF NOT EXISTS idx_executions_task ON task_executions(task_id, created_at DESC)")
    service.DB.Exec("CREATE INDEX IF NOT EXISTS idx_executions_session ON task_executions(session_id)")

    fmt.Println("Schema migration complete.")
}
```

**Note on session_id matching:** The above `INSERT...SELECT` tries to match old execution rows to their newly created sessions. An alternative is to add `session_id` to the old table first (`ALTER TABLE task_executions ADD COLUMN session_id TEXT DEFAULT ''`), update it during the per-row migration loop, then rename/create/copy. This is more reliable.

## Code Change Summary

### Go Backend

| File | Change |
|---|---|
| `service/database.go` | `task_executions` CREATE TABLE uses new schema (no `content`, adds `session_id`, `status`); `chat_sessions` CREATE TABLE adds `session_type`; add `idx_sessions_type` and `idx_executions_session` indexes |
| `service/scheduler.go` | `executeTask()`: create session → write user message → execute AI → write assistant message → insert `task_executions` (no content). Handle cancel (status='cancelled') and failure (status='failed'). `AddTaskExecution()` changes signature to `(taskID, sessionID, triggerType)`. New `UpdateExecutionStatus(sessionID, status)`. |
| `service/chat.go` | `CreateSession()` adds `sessionType` parameter. `GetSessions()` adds `session_type = 'chat'` filter + scans new column. `GetSessionCount()` adds `session_type = 'chat'` filter. `PurgeDeletedData()` adds `task_executions` cleanup. `ChatSession` scan adds `session_type`. |
| `handler/scheduler.go` | `serveTaskExecutions()`: single JOIN query with `status`, `session_id`. `DeleteTask()`: cascade soft-delete sessions + delete task_executions rows. Remove old `Execution` struct, add new one with `SessionID`, `Status`. |
| `model/chat.go` | `ChatSession` struct adds `SessionType string` |
| `model/scheduler.go` | No struct changes needed |
| `cli/migrate.go` | New `clawbench migrate` subcommand for one-time data + schema migration |
| `rag/cleanup.go` | No changes needed — `PurgeDeletedData()` in chat.go handles `task_executions` cleanup |

### Frontend

| Component | Change |
|---|---|
| `TaskExecDetail.vue` | Minimal change: `execDetail.content` now comes from `chat_history` via JOIN instead of `task_executions.content`. Same JSON format, same `parseAssistantContent()` path. New `status` field available for cancelled/failed display. |
| `TaskHistoryTab.vue` | Add `status` badge (cancelled/failed) to execution list items. `content` source transparent (API response still has `content` field). |
| Session drawer/selector | No change needed — backend filters `session_type='chat'` |

### No Changes

- `chat_history` table structure
- `ContentBlock` model
- SSE streaming logic (future iteration)
- RAG indexer core logic (task execution sessions automatically covered by existing `GetUnindexedMessages()`)
- `scheduled_tasks` table structure
- `ChatMessageItem.vue`, `ContentBlocks.vue` rendering logic (already works with the content format)
- `session_runtime.go` (no session_type awareness needed)

## Breaking API Change

The `GET /api/tasks/{id}/executions` response format changes:

**Old:**
```json
{ "content": "{blocks:[...]}", "triggerType": "auto", "createdAt": "...", "isUnread": true }
```

**New:**
```json
{ "sessionId": "exec-xxxx", "triggerType": "auto", "status": "completed", "content": "{blocks:[...]}", "createdAt": "...", "isUnread": true }
```

- Added: `sessionId`, `status` fields
- `content` is now nullable (null for cancelled executions)
- Coordinated frontend deployment required

## Out of Scope (Future Iterations)

- Real-time SSE streaming for task executions (streaming=1 → 0 flow, reuse `UpdateStreamingMessage`/`FinalizeStreamingMessage`)
- Frontend UI to view execution details as a full chat session (with user message visible)
- Single execution deletion API endpoint
- Navigation from task execution to chat history
- Saving `ai_raw_responses` for scheduled executions
- Session runtime tracking for running executions (currently in `sync.Map`)
