package service

import (
	"database/sql"
	"encoding/json"
	"testing"
	"time"

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
			summarize_failed INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE IF NOT EXISTS chat_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_path TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
			content TEXT NOT NULL,
			file_path TEXT,
			files TEXT,
			session_id TEXT,
			backend TEXT NOT NULL DEFAULT 'claude',
			streaming INTEGER NOT NULL DEFAULT 0,
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

// ---------- Migration tests ----------

func TestInitDB_MigrationExternalSessionID(t *testing.T) {
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	var count int
	err := db.QueryRow(
		"SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'external_session_id'",
	).Scan(&count)
	assert.NoError(t, err)
	assert.Equal(t, 1, count, "external_session_id column should exist")
}

func TestInitDB_MigrationAgentSource(t *testing.T) {
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	var count int
	err := db.QueryRow(
		"SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'agent_source'",
	).Scan(&count)
	assert.NoError(t, err)
	assert.Equal(t, 1, count, "agent_source column should exist")
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

// ---------- TTS Summary cache ----------

func TestGetTTSSummary_NotFound(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	summary, failed, found := GetTTSSummary("nonexistent-key")
	assert.Equal(t, "", summary)
	assert.False(t, failed)
	assert.False(t, found)
}

func TestGetTTSSummary_Found(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	err := SaveTTSSummary("key-1", "hello world", false)
	assert.NoError(t, err)

	summary, failed, found := GetTTSSummary("key-1")
	assert.Equal(t, "hello world", summary)
	assert.False(t, failed)
	assert.True(t, found)
}

func TestGetTTSSummary_FailedEntry(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	err := SaveTTSSummary("key-fail", "raw text", true)
	assert.NoError(t, err)

	summary, failed, found := GetTTSSummary("key-fail")
	assert.Equal(t, "raw text", summary)
	assert.True(t, failed)
	assert.True(t, found)
}

func TestGetTTSSummary_FailedEntryExpired(t *testing.T) {
	db, teardown := setupTestDBForTTS(t)
	defer teardown()

	// Insert a failed entry with an old timestamp (beyond TTL).
	// Use UTC time since SQLite CURRENT_TIMESTAMP is UTC and the
	// modernc.org/sqlite driver returns DATETIME as RFC3339 with Z suffix.
	// Using local time would cause the driver to mislabel it as UTC.
	_, err := db.Exec(
		"INSERT OR REPLACE INTO tts_summaries (cache_key, summary, summarize_failed, created_at) VALUES (?, ?, ?, ?)",
		"key-expired", "old text", true, time.Now().UTC().Add(-15*time.Minute).Format("2006-01-02 15:04:05"),
	)
	assert.NoError(t, err)

	// Expired failed entry should be treated as cache miss
	summary, failed, found := GetTTSSummary("key-expired")
	assert.Equal(t, "", summary)
	assert.False(t, failed)
	assert.False(t, found)
}

func TestSaveTTSSummary_Upsert(t *testing.T) {
	_, teardown := setupTestDBForTTS(t)
	defer teardown()

	err := SaveTTSSummary("key-upsert", "version 1", false)
	assert.NoError(t, err)

	err = SaveTTSSummary("key-upsert", "version 2", false)
	assert.NoError(t, err)

	summary, _, found := GetTTSSummary("key-upsert")
	assert.True(t, found)
	assert.Equal(t, "version 2", summary)
}
