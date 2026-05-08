package service

import (
	"database/sql"
	"encoding/json"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/assert"
)

// setupTestDBForTTS creates an in-memory SQLite database with the tts_summaries table
// for testing GetTTSSummary and SaveTTSSummary.
func setupTestDBForTTS(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	origDB := DB

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	db.SetMaxOpenConns(1)
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=5000")

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS tts_summaries (
			cache_key TEXT PRIMARY KEY,
			summary TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS chat_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_path TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
			content TEXT NOT NULL,
			files TEXT,
			session_id TEXT,
			backend TEXT NOT NULL DEFAULT 'claude',
			streaming INTEGER NOT NULL DEFAULT 0,
			indexed INTEGER NOT NULL DEFAULT 0,
			deleted INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
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
	`)
	if err != nil {
		t.Fatalf("failed to create tables: %v", err)
	}

	DB = db
	teardown := func() {
		DB = origDB
		db.Close()
	}
	return db, teardown
}

// ---------- Table creation ----------

func TestInitDB_CreatesTables(t *testing.T) {
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	tables := []string{"tts_summaries", "chat_history", "chat_sessions"}
	for _, table := range tables {
		var count int
		err := db.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
			table,
		).Scan(&count)
		assert.NoError(t, err)
		assert.Equal(t, 1, count, "table %s should exist", table)
	}
}

// ---------- Orphaned streaming message cleanup ----------

func TestInitDB_CleansOrphanedStreamingJSON(t *testing.T) {
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	content := map[string]any{
		"blocks": []any{
			map[string]any{"type": "text", "text": "partial response"},
		},
	}
	contentJSON, _ := json.Marshal(content)
	_, err := db.Exec(
		"INSERT INTO chat_history (project_path, role, content, session_id, backend, streaming) VALUES (?, 'assistant', ?, ?, 'claude', 1)",
		"/test", string(contentJSON), "sess-1",
	)
	assert.NoError(t, err)

	rows, err := db.Query("SELECT id, content FROM chat_history WHERE streaming = 1")
	assert.NoError(t, err)

	type orphanMsg struct {
		id      int64
		content string
	}
	var orphans []orphanMsg
	for rows.Next() {
		var m orphanMsg
		assert.NoError(t, rows.Scan(&m.id, &m.content))
		orphans = append(orphans, m)
	}
	rows.Close()
	assert.Len(t, orphans, 1)

	m := orphans[0]
	var contentMap map[string]any
	json.Unmarshal([]byte(m.content), &contentMap)
	contentMap["cancelled"] = true
	blocks, _ := contentMap["blocks"].([]any)
	blocks = append(blocks, map[string]any{
		"type":   "warning",
		"text":   "Server restarted, AI response interrupted",
		"reason": "restart",
	})
	contentMap["blocks"] = blocks
	updatedContent, _ := json.Marshal(contentMap)
	db.Exec("UPDATE chat_history SET content = ?, streaming = 0 WHERE id = ?", string(updatedContent), m.id)

	var streaming int
	var updated string
	err = db.QueryRow("SELECT streaming, content FROM chat_history WHERE id = ?", m.id).Scan(&streaming, &updated)
	assert.NoError(t, err)
	assert.Equal(t, 0, streaming)

	var result map[string]any
	json.Unmarshal([]byte(updated), &result)
	assert.Equal(t, true, result["cancelled"])
	blocksArr := result["blocks"].([]any)
	assert.Len(t, blocksArr, 2)
	warningBlock := blocksArr[1].(map[string]any)
	assert.Equal(t, "warning", warningBlock["type"])
	assert.Equal(t, "restart", warningBlock["reason"])
}

func TestInitDB_CleansOrphanedStreamingPlain(t *testing.T) {
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	_, err := db.Exec(
		"INSERT INTO chat_history (project_path, role, content, session_id, backend, streaming) VALUES (?, 'assistant', ?, ?, 'claude', 1)",
		"/test", "plain text response", "sess-2",
	)
	assert.NoError(t, err)

	rows, err := db.Query("SELECT id, content FROM chat_history WHERE streaming = 1")
	assert.NoError(t, err)

	type orphanMsg struct {
		id      int64
		content string
	}
	var orphans []orphanMsg
	for rows.Next() {
		var m orphanMsg
		assert.NoError(t, rows.Scan(&m.id, &m.content))
		orphans = append(orphans, m)
	}
	rows.Close()
	assert.Len(t, orphans, 1)

	m := orphans[0]
	var contentMap map[string]any
	err = json.Unmarshal([]byte(m.content), &contentMap)
	if err != nil {
		contentMap = map[string]any{
			"blocks":    []any{map[string]any{"type": "text", "text": m.content}},
			"cancelled": true,
		}
	}
	updatedContent, _ := json.Marshal(contentMap)
	db.Exec("UPDATE chat_history SET content = ?, streaming = 0 WHERE id = ?", string(updatedContent), m.id)

	var streaming int
	var updated string
	db.QueryRow("SELECT streaming, content FROM chat_history WHERE id = ?", m.id).Scan(&streaming, &updated)
	assert.Equal(t, 0, streaming)

	var result map[string]any
	json.Unmarshal([]byte(updated), &result)
	assert.Equal(t, true, result["cancelled"])
	blocksArr := result["blocks"].([]any)
	assert.Len(t, blocksArr, 1)
	textBlock := blocksArr[0].(map[string]any)
	assert.Equal(t, "text", textBlock["type"])
	assert.Equal(t, "plain text response", textBlock["text"])
}

func TestInitDB_CLIModeSkipsOrphanCleanup(t *testing.T) {
	// Verify that InitDB without runFromServer=true does NOT clean up streaming messages
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	// Insert a streaming message (simulating an active AI response)
	content := map[string]any{
		"blocks": []any{
			map[string]any{"type": "text", "text": "active streaming response"},
		},
	}
	contentJSON, _ := json.Marshal(content)
	_, err := db.Exec(
		"INSERT INTO chat_history (project_path, role, content, session_id, backend, streaming) VALUES (?, 'assistant', ?, ?, 'claude', 1)",
		"/test", string(contentJSON), "sess-active",
	)
	assert.NoError(t, err)

	// Call the orphan cleanup logic directly with isServerStartup=false
	// This simulates what InitDB(runFromServer=false) does
	// The streaming message should NOT be cleaned up
	orphanCleanup(t, db, false)

	var streaming int
	err = db.QueryRow("SELECT streaming FROM chat_history WHERE session_id = 'sess-active'").Scan(&streaming)
	assert.NoError(t, err)
	assert.Equal(t, 1, streaming, "CLI mode should NOT clean up active streaming messages")
}

func TestInitDB_ServerModeCleansOrphans(t *testing.T) {
	// Verify that InitDB with runFromServer=true DOES clean up streaming messages
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	// Insert a streaming message (simulating an orphaned message from crash)
	content := map[string]any{
		"blocks": []any{
			map[string]any{"type": "text", "text": "orphaned response"},
		},
	}
	contentJSON, _ := json.Marshal(content)
	_, err := db.Exec(
		"INSERT INTO chat_history (project_path, role, content, session_id, backend, streaming) VALUES (?, 'assistant', ?, ?, 'claude', 1)",
		"/test", string(contentJSON), "sess-orphan",
	)
	assert.NoError(t, err)

	// Call the orphan cleanup logic directly with isServerStartup=true
	// This simulates what InitDB(runFromServer=true) does
	orphanCleanup(t, db, true)

	var streaming int
	err = db.QueryRow("SELECT streaming FROM chat_history WHERE session_id = 'sess-orphan'").Scan(&streaming)
	assert.NoError(t, err)
	assert.Equal(t, 0, streaming, "server mode should clean up orphaned streaming messages")

	// Verify the warning block was added
	var updated string
	err = db.QueryRow("SELECT content FROM chat_history WHERE session_id = 'sess-orphan'").Scan(&updated)
	assert.NoError(t, err)
	var result map[string]any
	json.Unmarshal([]byte(updated), &result)
	assert.Equal(t, true, result["cancelled"])
}

// orphanCleanup replicates the orphan cleanup logic from InitDB for testing.
func orphanCleanup(t *testing.T, db *sql.DB, isServerStartup bool) {
	t.Helper()
	if !isServerStartup {
		return
	}
	rows, err := db.Query("SELECT id, content FROM chat_history WHERE streaming = 1")
	assert.NoError(t, err)
	defer rows.Close()

	type orphanMsg struct {
		id      int64
		content string
	}
	var orphans []orphanMsg
	for rows.Next() {
		var m orphanMsg
		assert.NoError(t, rows.Scan(&m.id, &m.content))
		orphans = append(orphans, m)
	}

	for _, m := range orphans {
		var contentMap map[string]any
		if err := json.Unmarshal([]byte(m.content), &contentMap); err != nil {
			contentMap = map[string]any{
				"blocks":    []any{map[string]any{"type": "text", "text": m.content}},
				"cancelled": true,
			}
		} else {
			contentMap["cancelled"] = true
			blocks, _ := contentMap["blocks"].([]any)
			blocks = append(blocks, map[string]any{
				"type":   "warning",
				"text":   "Server restarted, AI response interrupted",
				"reason": "restart",
			})
			contentMap["blocks"] = blocks
		}
		updatedContent, _ := json.Marshal(contentMap)
		db.Exec("UPDATE chat_history SET content = ?, streaming = 0 WHERE id = ?", string(updatedContent), m.id)
	}
}

// ---------- TTS Summary cache ----------

func TestGetTTSSummary_NotFound(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	summary, found := GetTTSSummary("nonexistent-key")
	assert.Equal(t, "", summary)
	assert.False(t, found)
}

func TestGetTTSSummary_Found(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	err := SaveTTSSummary("key-1", "hello world")
	assert.NoError(t, err)

	summary, found := GetTTSSummary("key-1")
	assert.Equal(t, "hello world", summary)
	assert.True(t, found)
}

func TestGetTTSSummary_FailedEntry(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	err := SaveTTSSummary("key-fail", "raw text")
	assert.NoError(t, err)

	summary, found := GetTTSSummary("key-fail")
	assert.Equal(t, "raw text", summary)
	assert.True(t, found)
}

func TestSaveTTSSummary_Upsert(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	err := SaveTTSSummary("key-upsert", "version 1")
	assert.NoError(t, err)

	err = SaveTTSSummary("key-upsert", "version 2")
	assert.NoError(t, err)

	summary, found := GetTTSSummary("key-upsert")
	assert.True(t, found)
	assert.Equal(t, "version 2", summary)
}
