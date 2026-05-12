# Task Execution Chat Storage Merge — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge `task_executions.content` storage into `chat_sessions` + `chat_history` so scheduled task executions use the same data path as interactive chat.

**Architecture:** Each execution creates a dedicated `chat_session` (with `session_type='scheduled'`) and writes user/assistant messages via `AddChatMessage()`. The `task_executions` table becomes a thin join table (`task_id`, `session_id`, `trigger_type`, `status`). A `clawbench migrate` CLI subcommand handles one-time data migration from old schema.

**Tech Stack:** Go (SQLite via `modernc.org/sqlite`), Vue 3 + TypeScript (Composition API)

---

### Task 1: Schema — Update `database.go` CREATE TABLE statements

**Files:**
- Modify: `internal/service/database.go:67-81` (chat_sessions)
- Modify: `internal/service/database.go:106-112` (task_executions)
- Modify: `internal/service/database.go:124-128` (indexes)

**Step 1: Update `chat_sessions` CREATE TABLE**

Add `session_type TEXT NOT NULL DEFAULT 'chat'` column after the `external_session_id` line. The column must be in the CREATE TABLE statement (not ALTER TABLE) since this is the definitive schema for new databases.

In `internal/service/database.go`, change the `chat_sessions` CREATE TABLE block from:
```go
		CREATE TABLE IF NOT EXISTS chat_sessions (
			id TEXT PRIMARY KEY,
			project_path TEXT NOT NULL,
			backend TEXT NOT NULL,
			title TEXT NOT NULL,
			agent_id TEXT DEFAULT '',
			agent_source TEXT DEFAULT 'default',
			model TEXT DEFAULT '',
			external_session_id TEXT DEFAULT '',
			deleted INTEGER NOT NULL DEFAULT 0,
			last_read_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(project_path, backend, id)
		);
```
to:
```go
		CREATE TABLE IF NOT EXISTS chat_sessions (
			id TEXT PRIMARY KEY,
			project_path TEXT NOT NULL,
			backend TEXT NOT NULL,
			title TEXT NOT NULL,
			agent_id TEXT DEFAULT '',
			agent_source TEXT DEFAULT 'default',
			model TEXT DEFAULT '',
			external_session_id TEXT DEFAULT '',
			session_type TEXT NOT NULL DEFAULT 'chat',
			deleted INTEGER NOT NULL DEFAULT 0,
			last_read_at DATETIME,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(project_path, backend, id)
		);
```

**Step 2: Update `task_executions` CREATE TABLE**

Replace the old schema with the new thin join table. Change:
```go
		CREATE TABLE IF NOT EXISTS task_executions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL,
			content TEXT NOT NULL DEFAULT '',
			trigger_type TEXT NOT NULL DEFAULT 'auto',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
```
to:
```go
		CREATE TABLE IF NOT EXISTS task_executions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			task_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			trigger_type TEXT NOT NULL DEFAULT 'auto',
			status TEXT NOT NULL DEFAULT 'completed',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
```

**Step 3: Add new indexes**

After the existing index line `CREATE INDEX IF NOT EXISTS idx_executions_task ON task_executions(task_id, created_at DESC);`, add:
```go
		CREATE INDEX IF NOT EXISTS idx_executions_session ON task_executions(session_id);
		CREATE INDEX IF NOT EXISTS idx_sessions_type ON chat_sessions(session_type, project_path, deleted);
```

**Step 4: Run Go tests to verify schema compiles**

Run: `go build ./cmd/server`
Expected: BUILD SUCCESS

**Step 5: Commit**

```bash
git add internal/service/database.go
git commit -m "feat: update schema for task-execution chat merge

- chat_sessions: add session_type column (default 'chat')
- task_executions: replace content with session_id, add status column
- add idx_executions_session and idx_sessions_type indexes"
```

---

### Task 2: Model — Add `SessionType` to `ChatSession` struct

**Files:**
- Modify: `internal/model/chat.go:19-31`

**Step 1: Add `SessionType` field**

In `internal/model/chat.go`, add the field to the `ChatSession` struct after `Model`:
```go
type ChatSession struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Backend     string     `json:"backend"`
	AgentID     string     `json:"agentId,omitempty"`
	AgentSource string     `json:"agentSource,omitempty"`
	Model       string     `json:"model,omitempty"`
	SessionType string     `json:"sessionType,omitempty"` // "chat" (interactive) | "scheduled" (task execution)
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	Running     bool       `json:"running,omitempty"`
	UnreadCount int        `json:"unreadCount,omitempty"`
	LastReadAt  *time.Time `json:"-"`
}
```

**Step 2: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add internal/model/chat.go
git commit -m "feat: add SessionType field to ChatSession model"
```

---

### Task 3: Service — Update `CreateSession()` to accept `sessionType`

**Files:**
- Modify: `internal/service/chat.go:319-332`
- Modify: `internal/handler/chat.go:174` (caller 1)
- Modify: `internal/handler/chat_session.go:81` (caller 2)

**Step 1: Change `CreateSession` signature and body**

In `internal/service/chat.go`, change:
```go
func CreateSession(projectPath, backend, title, agentID, modelName, agentSource string) (string, error) {
	sessionID := generateSessionID()
	if sessionID == "" {
		return "", fmt.Errorf("failed to generate unique session ID after 10 attempts")
	}
	_, err := DB.Exec(
		"INSERT INTO chat_sessions (id, project_path, backend, title, agent_id, agent_source, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
		sessionID, projectPath, backend, title, agentID, agentSource, modelName,
	)
```
to:
```go
func CreateSession(projectPath, backend, title, agentID, modelName, agentSource, sessionType string) (string, error) {
	sessionID := generateSessionID()
	if sessionID == "" {
		return "", fmt.Errorf("failed to generate unique session ID after 10 attempts")
	}
	if sessionType == "" {
		sessionType = "chat"
	}
	_, err := DB.Exec(
		"INSERT INTO chat_sessions (id, project_path, backend, title, agent_id, agent_source, model, session_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		sessionID, projectPath, backend, title, agentID, agentSource, modelName, sessionType,
	)
```

**Step 2: Update caller in `handler/chat.go:174`**

Change:
```go
sessionID, err = service.CreateSession(projectPath, sessionBackend2, T(r, "NewSession"), agentID2, defaultModel2, "default")
```
to:
```go
sessionID, err = service.CreateSession(projectPath, sessionBackend2, T(r, "NewSession"), agentID2, defaultModel2, "default", "chat")
```

**Step 3: Update caller in `handler/chat_session.go:81`**

Change:
```go
sessionID, err := service.CreateSession(projectPath, backend, title, resolvedAgentID, agentModel, agentSource)
```
to:
```go
sessionID, err := service.CreateSession(projectPath, backend, title, resolvedAgentID, agentModel, agentSource, "chat")
```

**Step 4: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS (existing callers pass "chat", scheduler caller not yet added)

**Step 5: Commit**

```bash
git add internal/service/chat.go internal/handler/chat.go internal/handler/chat_session.go
git commit -m "feat: add sessionType parameter to CreateSession

All existing callers pass 'chat'. Scheduler will pass 'scheduled'."
```

---

### Task 4: Service — Add `session_type` filter to session queries

**Files:**
- Modify: `internal/service/chat.go:251-282` (`GetSessions`)
- Modify: `internal/service/chat.go:349-353` (`GetSessionCount`)

**Step 1: Update `GetSessions()` query**

In the `GetSessions()` function, add `session_type` to the SELECT list and add a filter condition.

Change the query from:
```go
	query := `SELECT s.id, s.title, s.backend, s.agent_id, s.agent_source, s.model, s.created_at, s.updated_at, s.last_read_at,
		(SELECT COUNT(*) FROM chat_history h WHERE h.session_id = s.id AND h.role = 'assistant' AND h.streaming = 0 AND h.deleted = 0
		 AND (s.last_read_at IS NULL OR h.created_at > s.last_read_at)) AS unread_count
		FROM chat_sessions s WHERE s.project_path = ? AND s.deleted = 0`
```
to:
```go
	query := `SELECT s.id, s.title, s.backend, s.agent_id, s.agent_source, s.model, s.session_type, s.created_at, s.updated_at, s.last_read_at,
		(SELECT COUNT(*) FROM chat_history h WHERE h.session_id = s.id AND h.role = 'assistant' AND h.streaming = 0 AND h.deleted = 0
		 AND (s.last_read_at IS NULL OR h.created_at > s.last_read_at)) AS unread_count
		FROM chat_sessions s WHERE s.project_path = ? AND s.deleted = 0 AND s.session_type = 'chat'`
```

Also update the scan to include `session_type`. Change the scan line from:
```go
		if err := rows.Scan(&s.ID, &s.Title, &s.Backend, &s.AgentID, &s.AgentSource, &s.Model, &s.CreatedAt, &s.UpdatedAt, &lastRead, &s.UnreadCount); err != nil {
```
to:
```go
		if err := rows.Scan(&s.ID, &s.Title, &s.Backend, &s.AgentID, &s.AgentSource, &s.Model, &s.SessionType, &s.CreatedAt, &s.UpdatedAt, &lastRead, &s.UnreadCount); err != nil {
```

**Step 2: Update `GetSessionCount()` query**

Change:
```go
func GetSessionCount(projectPath string) (int, error) {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM chat_sessions WHERE project_path = ? AND deleted = 0", projectPath).Scan(&count)
	return count, err
}
```
to:
```go
func GetSessionCount(projectPath string) (int, error) {
	var count int
	err := DB.QueryRow("SELECT COUNT(*) FROM chat_sessions WHERE project_path = ? AND deleted = 0 AND session_type = 'chat'", projectPath).Scan(&count)
	return count, err
}
```

**Step 3: Verify build and run chat tests**

Run: `go test ./internal/service/ -run TestGetSessions -v`
Expected: PASS (tests use fresh DB with new schema)

Run: `go test ./internal/service/ -run TestSessionCount -v`
Expected: PASS

**Step 4: Commit**

```bash
git add internal/service/chat.go
git commit -m "feat: filter session_type='chat' in GetSessions and GetSessionCount

Scheduled execution sessions won't appear in chat UI."
```

---

### Task 5: Service — Update `AddTaskExecution()` and add `UpdateExecutionStatus()`

**Files:**
- Modify: `internal/service/scheduler.go:619-626` (`AddTaskExecution`)

**Step 1: Rewrite `AddTaskExecution()` signature and body**

Change:
```go
// AddTaskExecution records a task execution with its content directly in task_executions.
func AddTaskExecution(taskID string, content string, triggerType string) error {
	_, err := DB.Exec(
		"INSERT INTO task_executions (task_id, content, trigger_type) VALUES (?, ?, ?)",
		taskID, content, triggerType,
	)
	return err
}
```
to:
```go
// AddTaskExecution records a task execution linked to a chat session.
func AddTaskExecution(taskID string, sessionID string, triggerType string) error {
	_, err := DB.Exec(
		"INSERT INTO task_executions (task_id, session_id, trigger_type) VALUES (?, ?, ?)",
		taskID, sessionID, triggerType,
	)
	return err
}

// UpdateExecutionStatus updates the status of a task execution by session_id.
func UpdateExecutionStatus(sessionID string, status string) error {
	_, err := DB.Exec(
		"UPDATE task_executions SET status = ? WHERE session_id = ?",
		status, sessionID,
	)
	return err
}
```

**Step 2: Verify build**

Run: `go build ./...`
Expected: BUILD FAIL — callers of old `AddTaskExecution(taskID, content, triggerType)` will fail. That's expected; fixed in Task 6.

**Step 3: Commit**

```bash
git add internal/service/scheduler.go
git commit -m "feat: rewrite AddTaskExecution for session-based storage

- AddTaskExecution(taskID, sessionID, triggerType) — no content
- New UpdateExecutionStatus(sessionID, status) for cancel/failure
- Callers updated in next task"
```

---

### Task 6: Service — Rewrite `executeTask()` to use chat sessions

**Files:**
- Modify: `internal/service/scheduler.go:343-525` (`executeTask`)

This is the core logic change. The function currently accumulates content blocks and writes them to `task_executions.content`. It must now create a session, write messages, and insert a thin `task_executions` row.

**Step 1: Rewrite `executeTask()`**

Replace the entire function body (lines 343-525) with:

```go
// executeTask runs a scheduled task by invoking the AI backend and storing
// the result as user/assistant messages in a chat session.
func (s *Scheduler) executeTask(task *model.ScheduledTask, projectPath string, triggerType string) {
	slog.Info("executing scheduled task",
		slog.String("task_id", task.ID),
		slog.String("name", task.Name),
	)

	agent, ok := model.Agents[task.AgentID]
	if !ok {
		slog.Error("agent not found for task, pausing",
			slog.String("agent_id", task.AgentID),
			slog.String("task_id", task.ID),
			slog.String("name", task.Name),
		)
		s.PauseTask(task.ID)
		return
	}

	backendName := agent.Backend
	if backendName == "" {
		backendName = "codebuddy"
	}

	// Create a chat session for this execution
	sessionID, err := CreateSession(projectPath, backendName, task.Name, task.AgentID, "", "default", "scheduled")
	if err != nil {
		slog.Error("failed to create session for task execution",
			slog.String("task_id", task.ID),
			slog.String("err", err.Error()),
		)
		return
	}

	// Insert task_executions join row (optimistic: status='completed')
	if err := AddTaskExecution(task.ID, sessionID, triggerType); err != nil {
		slog.Error("failed to record task execution",
			slog.String("task_id", task.ID),
			slog.String("err", err.Error()),
		)
		return
	}

	// Write user message (task prompt)
	if _, err := AddChatMessage(projectPath, backendName, sessionID, "user", task.Prompt, nil, false, task.Name); err != nil {
		slog.Error("failed to write user message for task execution",
			slog.String("task_id", task.ID),
			slog.String("err", err.Error()),
		)
	}

	// Build system prompt with anti-recursion (strip scheduler skill)
	systemPrompt := agent.SystemPrompt
	if projectPath != "" {
		systemPrompt = strings.ReplaceAll(systemPrompt, "{{PROJECT_PATH}}", projectPath)
	}
	scheduledCommon := model.BuildCommonPrompt(true)
	normalCommon := model.BuildCommonPrompt(false)
	if normalCommon != "" && strings.HasPrefix(systemPrompt, normalCommon) {
		remaining := systemPrompt[len(normalCommon):]
		if scheduledCommon != "" {
			systemPrompt = scheduledCommon + remaining
		} else {
			systemPrompt = strings.TrimPrefix(remaining, "\n\n")
		}
	}

	chatReq := ai.ChatRequest{
		Prompt:             task.Prompt,
		SessionID:          sessionID,
		WorkDir:            projectPath,
		SystemPrompt:       systemPrompt,
		Model:              agent.DefaultModelID(),
		Command:            agent.Command,
		AgentID:            task.AgentID,
		Resume:             false,
		ScheduledExecution: true,
	}

	// Execute AI backend
	ctx, cancel := context.WithCancel(context.Background())

	// Register running execution
	execID := sessionID // use sessionID as execution ID for cancel tracking
	running := &RunningExecution{
		ID:          execID,
		TaskID:      task.ID,
		CancelFunc:  cancel,
		StartedAt:   time.Now(),
		TriggerType: triggerType,
	}
	s.runningExecutions.Store(execID, running)
	defer func() {
		s.runningExecutions.Delete(execID)
		cancel()
	}()

	backend, err := ai.NewBackend(backendName)
	if err != nil {
		slog.Error("failed to create backend for task", slog.String("err", err.Error()))
		UpdateExecutionStatus(sessionID, "failed")
		return
	}

	eventCh, err := backend.ExecuteStream(ctx, chatReq)
	if err != nil {
		slog.Error("failed to execute stream for task", slog.String("err", err.Error()))
		UpdateExecutionStatus(sessionID, "failed")
		return
	}

	// Consume streaming events and build content blocks
	var blocks []model.ContentBlock
	var responseMetadata *ai.Metadata
	wallStart := time.Now()

	for event := range eventCh {
		switch event.Type {
		case "metadata":
			if event.Meta != nil {
				responseMetadata = event.Meta
			}
		case "done", "error":
			// Terminal events
		default:
			ai.AccumulateBlock(&blocks, event)
		}
	}

	// If context was cancelled, mark execution as cancelled
	if ctx.Err() == context.Canceled {
		slog.Info("task execution cancelled",
			slog.String("task_id", task.ID),
			slog.String("session_id", sessionID),
		)
		UpdateExecutionStatus(sessionID, "cancelled")
		// Still update task stats
		updateTaskStats(task, "active")
		return
	}

	// Compute wall-clock duration and inject into metadata
	wallMs := int(time.Since(wallStart).Milliseconds())
	if responseMetadata == nil {
		responseMetadata = &ai.Metadata{}
	}
	responseMetadata.WallMs = wallMs

	// Build content JSON and write assistant message
	contentMap := map[string]any{"blocks": blocks}
	if responseMetadata != nil {
		contentMap["metadata"] = responseMetadata
	}
	contentJSON, _ := json.Marshal(contentMap)

	if _, err := AddChatMessage(projectPath, backendName, sessionID, "assistant", string(contentJSON), nil, false, ""); err != nil {
		slog.Error("failed to write assistant message for task execution",
			slog.String("task_id", task.ID),
			slog.String("err", err.Error()),
		)
	}

	// Update task execution stats
	now := time.Now()
	newStatus := task.Status

	// Check repeat mode
	if task.RepeatMode == "limited" {
		var currentCount int
		if err := DB.QueryRow("SELECT run_count FROM scheduled_tasks WHERE id = ?", task.ID).Scan(&currentCount); err == nil {
			if currentCount+1 >= task.MaxRuns {
				newStatus = "completed"
			}
		}
	}
	if task.RepeatMode == "once" {
		newStatus = "completed"
	}

	schedule, _ := cron.ParseStandard(task.CronExpr)
	var nextRunAt *time.Time
	if newStatus == "active" {
		nr := schedule.Next(now)
		nextRunAt = &nr
	} else {
		s.mu.Lock()
		if entryID, ok := s.entries[task.ID]; ok {
			s.cron.Remove(entryID)
			delete(s.entries, task.ID)
		}
		s.mu.Unlock()
	}

	if nextRunAt != nil {
		DB.Exec("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			now, nextRunAt, newStatus, task.ID)
	} else {
		DB.Exec("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = NULL, run_count = run_count + 1, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			now, newStatus, task.ID)
	}

	slog.Info("task execution completed",
		slog.String("task_id", task.ID),
		slog.String("session_id", sessionID),
		slog.String("status", newStatus),
	)
}

// updateTaskStats increments run_count and updates last_run_at for a task.
// Used when execution is cancelled (no status change for the task itself).
func updateTaskStats(task *model.ScheduledTask, newStatus string) {
	now := time.Now()
	DB.Exec("UPDATE scheduled_tasks SET last_run_at = ?, run_count = run_count + 1, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		now, newStatus, task.ID)
}
```

**Step 2: Remove `generateExecutionID()` function**

Since `sessionID` is now used as the execution ID, `generateExecutionID()` at line 668 is no longer needed. Delete:
```go
func generateExecutionID() string {
	return generateUUID("exec-", "task_executions", "id")
}
```

**Step 3: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add internal/service/scheduler.go
git commit -m "feat: rewrite executeTask to use chat sessions

- Creates chat_session per execution (session_type='scheduled')
- Writes user/assistant messages via AddChatMessage
- task_executions row links to session (no content)
- Cancelled executions: status='cancelled', no assistant message
- Remove generateExecutionID, reuse sessionID"
```

---

### Task 7: Service — Update `RemoveTask()` to cascade-delete sessions

**Files:**
- Modify: `internal/service/scheduler.go:202-212` (`RemoveTask`)

**Step 1: Rewrite `RemoveTask()` to cascade**

Change:
```go
func (s *Scheduler) RemoveTask(id string) {
	s.mu.Lock()
	if entryID, ok := s.entries[id]; ok {
		s.cron.Remove(entryID)
		delete(s.entries, id)
	}
	s.mu.Unlock()

	DB.Exec("UPDATE scheduled_tasks SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
}
```
to:
```go
func (s *Scheduler) RemoveTask(id string) {
	s.mu.Lock()
	if entryID, ok := s.entries[id]; ok {
		s.cron.Remove(entryID)
		delete(s.entries, id)
	}
	s.mu.Unlock()

	// Cascade: soft-delete all execution sessions + hard-delete task_executions rows
	rows, err := DB.Query(
		"SELECT te.session_id, cs.project_path, cs.backend FROM task_executions te JOIN chat_sessions cs ON te.session_id = cs.id WHERE te.task_id = ?",
		id,
	)
	if err == nil {
		var sessionIDs []string
		for rows.Next() {
			var sessionID, projectPath, backend string
			if rows.Scan(&sessionID, &projectPath, &backend) == nil {
				DeleteSession(projectPath, backend, sessionID)
				sessionIDs = append(sessionIDs, sessionID)
			}
		}
		rows.Close()
	}
	DB.Exec("DELETE FROM task_executions WHERE task_id = ?", id)

	DB.Exec("UPDATE scheduled_tasks SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
}
```

**Step 2: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add internal/service/scheduler.go
git commit -m "feat: cascade-delete execution sessions when removing task

RemoveTask now soft-deletes associated chat_sessions and
hard-deletes task_executions rows before marking task deleted."
```

---

### Task 8: Service — Update `PurgeDeletedData()` to clean `task_executions`

**Files:**
- Modify: `internal/service/chat.go:520-563` (`PurgeDeletedData`)

**Step 1: Add `task_executions` cleanup to `PurgeDeletedData()`**

After the `DELETE FROM chat_sessions` block (line 553-557), add a new block:

```go
	// Delete task_executions for purged scheduled sessions
	_, _ = tx.Exec("DELETE FROM task_executions WHERE session_id IN ("+placeholders+")", args...)
```

This goes right after:
```go
	result, err = tx.Exec("DELETE FROM chat_sessions WHERE id IN ("+placeholders+") AND deleted = 1", args...)
```

**Step 2: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add internal/service/chat.go
git commit -m "feat: clean up task_executions when purging deleted sessions

PurgeDeletedData now also deletes task_executions rows for
scheduled sessions that have exceeded retention period."
```

---

### Task 9: Handler — Rewrite `serveTaskExecutions()` with JOIN query

**Files:**
- Modify: `internal/handler/scheduler.go:237-285`

**Step 1: Rewrite `serveTaskExecutions()`**

Replace the entire function with:

```go
// serveTaskExecutions returns the execution history for a task.
// Uses JOIN to fetch content from chat_history instead of task_executions.content.
func serveTaskExecutions(w http.ResponseWriter, r *http.Request, taskID string) {
	task, err := service.GetTaskByID(taskID)
	if err != nil {
		writeLocalizedError(w, r, model.NotFound(nil, "TaskNotFound"))
		return
	}

	type Execution struct {
		SessionID   string  `json:"sessionId"`
		TriggerType string  `json:"triggerType"`
		Status      string  `json:"status"`
		Content     *string `json:"content"`
		CreatedAt   string  `json:"createdAt"`
		IsUnread    bool    `json:"isUnread"`
	}

	rows, err := service.DB.Query(`
		SELECT te.session_id, te.trigger_type, te.status, te.created_at,
		       ch.content AS assistant_content
		FROM task_executions te
		LEFT JOIN chat_history ch ON ch.session_id = te.session_id
		    AND ch.role = 'assistant'
		    AND ch.deleted = 0
		    AND ch.streaming = 0
		WHERE te.task_id = ?
		ORDER BY te.created_at DESC
	`, taskID)
	if err != nil {
		model.WriteError(w, model.Internal(fmt.Errorf("failed to load execution history")))
		return
	}
	defer rows.Close()

	var executions []Execution
	for rows.Next() {
		var exec Execution
		var content sql.NullString
		if err := rows.Scan(&exec.SessionID, &exec.TriggerType, &exec.Status, &exec.CreatedAt, &content); err != nil {
			model.WriteError(w, model.Internal(fmt.Errorf("failed to scan execution record")))
			return
		}
		if content.Valid {
			exec.Content = &content.String
		}
		if task.LastReadAt == nil {
			exec.IsUnread = true
		} else {
			createdAt, parseErr := time.Parse(time.RFC3339, exec.CreatedAt)
			if parseErr == nil {
				exec.IsUnread = createdAt.After(*task.LastReadAt)
			}
		}
		executions = append(executions, exec)
	}

	if executions == nil {
		executions = []Execution{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"executions": executions})
}
```

Add the required `database/sql` import if not already present.

**Step 2: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add internal/handler/scheduler.go
git commit -m "feat: rewrite serveTaskExecutions with JOIN query

- Single JOIN query replaces N+1 pattern
- New response fields: sessionId, status
- content is now nullable (null for cancelled executions)
- Add database/sql import for NullString"
```

---

### Task 10: CLI — Add `clawbench migrate` subcommand

**Files:**
- Create: `internal/cli/migrate.go`
- Modify: `cmd/server/main.go:71-96` (add dispatch)

**Step 1: Create `internal/cli/migrate.go`**

```go
package cli

import (
	"database/sql"
	"fmt"
	"os"

	"clawbench/internal/model"
	"clawbench/internal/service"
)

// ---------- Help definitions ----------

var migrateHelp = HelpInfo{
	Usage:       "clawbench migrate",
	Description: "One-time migration: move task execution content into chat sessions. Run before deploying the new binary on an old database.",
}

// RunMigrateCommand handles the 'clawbench migrate' subcommand.
func RunMigrateCommand(args []string) int {
	if len(args) > 0 && (args[0] == "--help" || args[0] == "-h") {
		printHelp(migrateHelp)
		return 0
	}

	loadConfig()
	service.InitDB()

	// Check if migration is needed
	var hasContentCol int
	err := service.DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('task_executions') WHERE name='content'").Scan(&hasContentCol)
	if err != nil {
		return outputError("failed to check schema: " + err.Error())
	}
	if hasContentCol == 0 {
		fmt.Println("No migration needed — schema is already up to date.")
		return 0
	}

	var hasSessionIDCol int
	service.DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('task_executions') WHERE name='session_id'").Scan(&hasSessionIDCol)
	if hasSessionIDCol > 0 {
		fmt.Println("No migration needed — session_id column already exists.")
		return 0
	}

	// Ensure chat_sessions has session_type column
	var hasSessionType int
	service.DB.QueryRow("SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name='session_type'").Scan(&hasSessionType)
	if hasSessionType == 0 {
		if _, err := service.DB.Exec("ALTER TABLE chat_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'chat'"); err != nil {
			return outputError("failed to add session_type column: " + err.Error())
		}
		fmt.Println("Added session_type column to chat_sessions.")
	}

	// Add session_id column to old task_executions for tracking
	if _, err := service.DB.Exec("ALTER TABLE task_executions ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); err != nil {
		return outputError("failed to add session_id column: " + err.Error())
	}

	// Migrate each execution row
	rows, err := service.DB.Query("SELECT id, task_id, content, trigger_type, created_at FROM task_executions")
	if err != nil {
		return outputError("failed to query task_executions: " + err.Error())
	}
	defer rows.Close()

	migrated := 0
	skipped := 0
	for rows.Next() {
		var id int64
		var taskID, content, triggerType, createdAt string
		if err := rows.Scan(&id, &taskID, &content, &triggerType, &createdAt); err != nil {
			fmt.Fprintf(os.Stderr, "  skipping row: scan error: %v\n", err)
			skipped++
			continue
		}

		// Look up task for metadata
		var taskName, agentID, prompt, projectPath string
		err := service.DB.QueryRow(
			"SELECT name, agent_id, prompt, project_path FROM scheduled_tasks WHERE id = ?", taskID,
		).Scan(&taskName, &agentID, &prompt, &projectPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "  skipping exec %d: task %s not found\n", id, taskID)
			skipped++
			continue
		}

		// Resolve backend from agent config
		backend := "codebuddy"
		if agent, ok := model.Agents[agentID]; ok && agent.Backend != "" {
			backend = agent.Backend
		}

		// Create chat session
		sessionID, err := service.CreateSession(projectPath, backend, taskName, agentID, "", "default", "scheduled")
		if err != nil {
			fmt.Fprintf(os.Stderr, "  skipping exec %d: failed to create session: %v\n", id, err)
			skipped++
			continue
		}

		// Write user message
		service.AddChatMessage(projectPath, backend, sessionID, "user", prompt, nil, false, taskName)

		// Write assistant message (if content exists)
		if content != "" {
			service.AddChatMessage(projectPath, backend, sessionID, "assistant", content, nil, false, "")
		}

		// Update session_id in the old row
		service.DB.Exec("UPDATE task_executions SET session_id = ? WHERE id = ?", sessionID, id)

		migrated++
		fmt.Fprintf(os.Stderr, "  migrated exec %d -> session %s\n", id, sessionID)
	}

	// Apply new schema: rename old → create new → copy data → drop old
	fmt.Println("Applying new schema...")
	service.DB.Exec("ALTER TABLE task_executions RENAME TO task_executions_old")
	service.DB.Exec(`CREATE TABLE task_executions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		task_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		trigger_type TEXT NOT NULL DEFAULT 'auto',
		status TEXT NOT NULL DEFAULT 'completed',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
	_, err = service.DB.Exec(`INSERT INTO task_executions (id, task_id, session_id, trigger_type, status, created_at)
		SELECT id, task_id, session_id, trigger_type, 'completed', created_at FROM task_executions_old`)
	if err != nil {
		return outputError("failed to copy data to new schema: " + err.Error())
	}
	service.DB.Exec("DROP TABLE task_executions_old")
	service.DB.Exec("CREATE INDEX IF NOT EXISTS idx_executions_task ON task_executions(task_id, created_at DESC)")
	service.DB.Exec("CREATE INDEX IF NOT EXISTS idx_executions_session ON task_executions(session_id)")

	fmt.Printf("Migration complete: %d executions migrated, %d skipped.\n", migrated, skipped)
	return 0
}
```

**Step 2: Add dispatch in `cmd/server/main.go`**

After the RAG subcommand dispatch (line 96), add:

```go
	// Migrate subcommand dispatch
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		os.Exit(cli.RunMigrateCommand(os.Args[2:]))
	}
```

Also add `migrate` to the root --help listing:
```go
		fmt.Println("  migrate Migrate old task_executions data to chat sessions")
```

**Step 3: Verify build**

Run: `go build ./...`
Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add internal/cli/migrate.go cmd/server/main.go
git commit -m "feat: add 'clawbench migrate' subcommand

One-time migration command that:
- Detects old schema (task_executions has content column)
- Creates chat sessions + user/assistant messages for each execution
- Applies new task_executions schema (session_id, status)
- Must be run before deploying on existing databases"
```

---

### Task 11: Tests — Update `AddTaskExecution` tests

**Files:**
- Modify: `internal/service/scheduler_test.go:590-632`

**Step 1: Update `TestAddTaskExecution`**

The test calls `AddTaskExecution("task-1", content, "cron")` with the old 3-arg signature. Update to use the new signature and verify the session_id is stored correctly.

Replace:
```go
func TestAddTaskExecution(t *testing.T) {
	_, cleanup := setupScheduler(t)
	defer cleanup()

	// Insert a task
	now := time.Now()
	service.DB.Exec(
		"INSERT INTO scheduled_tasks (id, project_path, name, cron_expr, agent_id, prompt, session_id, status, repeat_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		"task-1", "/proj", "Task", "0 * * * *", "agent1", "p", "", "active", "unlimited", now, now,
	)

	content := `{"blocks":[{"type":"text","text":"execution result"}]}`
	err := service.AddTaskExecution("task-1", content, "cron")
	assert.NoError(t, err)

	// Verify the execution was recorded
	var count int
	err = service.DB.QueryRow("SELECT COUNT(*) FROM task_executions WHERE task_id = ?", "task-1").Scan(&count)
	assert.NoError(t, err)
	assert.Equal(t, 1, count)

	var fetchedContent string
	err = service.DB.QueryRow("SELECT content FROM task_executions WHERE task_id = ?", "task-1").Scan(&fetchedContent)
	assert.NoError(t, err)
	assert.Equal(t, content, fetchedContent)
}

func TestAddTaskExecution_MultipleExecutions(t *testing.T) {
	_, cleanup := setupScheduler(t)
	defer cleanup()

	err := service.AddTaskExecution("task-1", `{"blocks":[{"type":"text","text":"result1"}]}`, "cron")
	assert.NoError(t, err)
	err = service.AddTaskExecution("task-1", `{"blocks":[{"type":"text","text":"result2"}]}`, "cron")
	assert.NoError(t, err)

	var count int
	err = service.DB.QueryRow("SELECT COUNT(*) FROM task_executions WHERE task_id = ?", "task-1").Scan(&count)
	assert.NoError(t, err)
	assert.Equal(t, 2, count)
}
```

with:
```go
func TestAddTaskExecution(t *testing.T) {
	_, cleanup := setupScheduler(t)
	defer cleanup()

	// Insert a task
	now := time.Now()
	service.DB.Exec(
		"INSERT INTO scheduled_tasks (id, project_path, name, cron_expr, agent_id, prompt, session_id, status, repeat_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		"task-1", "/proj", "Task", "0 * * * *", "agent1", "p", "", "active", "unlimited", now, now,
	)

	err := service.AddTaskExecution("task-1", "session-abc", "auto")
	assert.NoError(t, err)

	// Verify the execution was recorded with session_id
	var count int
	err = service.DB.QueryRow("SELECT COUNT(*) FROM task_executions WHERE task_id = ?", "task-1").Scan(&count)
	assert.NoError(t, err)
	assert.Equal(t, 1, count)

	var fetchedSessionID string
	err = service.DB.QueryRow("SELECT session_id FROM task_executions WHERE task_id = ?", "task-1").Scan(&fetchedSessionID)
	assert.NoError(t, err)
	assert.Equal(t, "session-abc", fetchedSessionID)
}

func TestAddTaskExecution_MultipleExecutions(t *testing.T) {
	_, cleanup := setupScheduler(t)
	defer cleanup()

	err := service.AddTaskExecution("task-1", "session-1", "auto")
	assert.NoError(t, err)
	err = service.AddTaskExecution("task-1", "session-2", "manual")
	assert.NoError(t, err)

	var count int
	err = service.DB.QueryRow("SELECT COUNT(*) FROM task_executions WHERE task_id = ?", "task-1").Scan(&count)
	assert.NoError(t, err)
	assert.Equal(t, 2, count)
}
```

**Step 2: Update handler test that calls `AddTaskExecution`**

In `internal/handler/scheduler_agent_test.go:442`, change:
```go
	service.AddTaskExecution(task.ID, `{"blocks":[{"type":"text","text":"result"}]}`, "manual")
```
to:
```go
	service.AddTaskExecution(task.ID, "session-test", "manual")
```

But since the JOIN query now expects a matching `chat_history` row for content, this test needs more setup. Update to create a session and write a message:

```go
	// Create execution session and write assistant message
	sessionID, _ := service.CreateSession(env.ProjectDir, "codebuddy", task.Name, "coder", "", "default", "scheduled")
	service.AddChatMessage(env.ProjectDir, "codebuddy", sessionID, "user", task.Prompt, nil, false, task.Name)
	service.AddChatMessage(env.ProjectDir, "codebuddy", sessionID, "assistant", `{"blocks":[{"type":"text","text":"result"}]}`, nil, false, "")
	service.AddTaskExecution(task.ID, sessionID, "manual")
```

**Step 3: Run tests**

Run: `go test ./internal/service/ -run TestAddTaskExecution -v`
Expected: PASS

Run: `go test ./internal/handler/ -run TestServeTaskByID_Executions -v`
Expected: PASS

**Step 4: Commit**

```bash
git add internal/service/scheduler_test.go internal/handler/scheduler_agent_test.go
git commit -m "test: update AddTaskExecution tests for new signature

- Verify session_id storage instead of content
- Handler test creates session + messages for JOIN query"
```

---

### Task 12: Frontend — Update `TaskHistoryTab.vue` for new API response

**Files:**
- Modify: `web/src/components/task/TaskHistoryTab.vue`

**Step 1: Update execution list to handle `status` and nullable `content`**

The `content` field is now nullable. When `status === 'cancelled'`, `content` is null. Update the summary extraction to handle this.

Find the `extractSummary` function or inline logic where `exec.content` is parsed. Add a null check:

```typescript
// Before (line ~102):
const { blocks } = chatRender.parseAssistantContent(exec.content)

// After:
const { blocks } = chatRender.parseAssistantContent(exec.content || '{}')
```

**Step 2: Add status badge to execution list items**

In the template, after the trigger type badge, add a status badge for non-completed executions:

```html
<span v-if="exec.status === 'cancelled'" class="exec-status cancelled">{{ t('task.exec.cancelled') }}</span>
<span v-else-if="exec.status === 'failed'" class="exec-status failed">{{ t('task.exec.failed') }}</span>
```

Add corresponding CSS (minimal, matching existing badge styles):

```css
.exec-status.cancelled {
  background: var(--color-bg-3);
  color: var(--color-text-3);
}
.exec-status.failed {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}
```

**Step 3: Verify frontend build**

Run: `npm run build --prefix web`
Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add web/src/components/task/TaskHistoryTab.vue
git commit -m "feat: handle nullable content and status in execution list

- Null-safe parseAssistantContent for cancelled executions
- Status badges for cancelled/failed executions"
```

---

### Task 13: Frontend — Update `TaskExecDetail.vue` for nullable content

**Files:**
- Modify: `web/src/components/task/TaskExecDetail.vue`

**Step 1: Handle null content in `msgData` computed**

Find the `msgData` computed property (line ~103-117). Change:

```typescript
// Before:
if (!props.execDetail?.content) return null
const { blocks } = chatRender.parseAssistantContent(props.execDetail.content)
```

to:

```typescript
if (!props.execDetail?.content && props.execDetail?.status !== 'cancelled') return null
const { blocks } = chatRender.parseAssistantContent(props.execDetail.content || '{}')
```

**Step 2: Add cancelled/failed state display**

After the `msgData` check, add a template section for cancelled executions:

```html
<div v-if="!msgData && execDetail?.status === 'cancelled'" class="exec-cancelled-notice">
  {{ t('task.exec.cancelledNotice') }}
</div>
```

With minimal CSS:

```css
.exec-cancelled-notice {
  padding: 1rem;
  text-align: center;
  color: var(--color-text-3);
  font-style: italic;
}
```

**Step 3: Verify frontend build**

Run: `npm run build --prefix web`
Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add web/src/components/task/TaskExecDetail.vue
git commit -m "feat: handle cancelled/failed execution in detail view

- Null-safe content parsing
- Cancelled notice when no assistant message exists"
```

---

### Task 14: Run full test suite and fix any remaining issues

**Files:**
- Various test files

**Step 1: Run all Go tests**

Run: `go test ./...`
Expected: ALL PASS. If any test references `task_executions.content` or old `AddTaskExecution` signature, fix it.

**Step 2: Run all frontend tests**

Run: `npm test --prefix web`
Expected: ALL PASS

**Step 3: Manual smoke test**

1. Build: `./build.sh`
2. Start: `./server.sh --fg`
3. Open browser → Chat → verify sessions appear normally
4. Open Tasks → create a task → trigger it → verify execution detail shows correctly
5. Verify chat session drawer does NOT show scheduled sessions
6. Verify session count limit excludes scheduled sessions

**Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "fix: test fixes for task-execution chat merge"
```

---

### Task 15: Final cleanup and documentation update

**Files:**
- Modify: `CODEBUDDY.md` (architecture docs)
- Modify: `docs/plans/2026-08-12-task-execution-chat-merge-design.md` (mark as implemented)

**Step 1: Update CODEBUDDY.md architecture section**

Update the "Scheduled task system" data flow to reflect chat-based storage. Update "Data flow for chat" if needed. Update the `chat_sessions` table description to mention `session_type`.

**Step 2: Mark design doc as implemented**

Add to the top of the design doc:
```
**Status:** Implemented
**Implemented:** 2026-08-12
```

**Step 3: Commit**

```bash
git add CODEBUDDY.md docs/plans/2026-08-12-task-execution-chat-merge-design.md
git commit -m "docs: update architecture docs for task-execution chat merge"
```
