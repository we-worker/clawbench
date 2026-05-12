package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

// migrate_task_id migrates scheduled_tasks.id from TEXT UUID to INTEGER AUTOINCREMENT
// and task_executions.task_id from TEXT to INTEGER.
//
// Usage:
//   go run scripts/migrate_task_id.go [db_path]
//
// If db_path is not provided, it defaults to .clawbench/ClawBench.db in the current directory.
//
// Steps:
// 1. Read all existing tasks with their TEXT IDs
// 2. Create new scheduled_tasks table with INTEGER PRIMARY KEY AUTOINCREMENT
// 3. Copy data, assigning new sequential integer IDs
// 4. Build old→new ID mapping
// 5. Update task_executions.task_id using the mapping
// 6. Drop old table, rename new → old
// 7. Recreate indexes

func main() {
	dbPath := ""
	if len(os.Args) > 1 {
		dbPath = os.Args[1]
	} else {
		dbPath = filepath.Join(".clawbench", "ClawBench.db")
	}

	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Database not found: %s\n", dbPath)
		os.Exit(1)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open database: %v\n", err)
		os.Exit(1)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	// Enable WAL mode
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to set WAL mode: %v\n", err)
		os.Exit(1)
	}

	// Check if migration is needed
	var colType string
	err = db.QueryRow("SELECT typeof(id) FROM scheduled_tasks LIMIT 1").Scan(&colType)
	if err == sql.ErrNoRows {
		// Empty table — just check the schema
		var dataType string
		err = db.QueryRow("SELECT data_type FROM pragma_table_info('scheduled_tasks') WHERE name='id'").Scan(&dataType)
		if err != nil {
			// pragma_table_info might not have data_type, use a different check
			// Try to insert a text value — if it works, still on old schema
			fmt.Println("Checking schema...")
		}
	}

	// Simpler check: see if the id column type contains "INT"
	var cols []struct {
		cid       int
		name      string
		dataType  string
		notNull   int
		defaultV  interface{}
		pk        int
	}

	rows, err := db.Query("PRAGMA table_info(scheduled_tasks)")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to query table info: %v\n", err)
		os.Exit(1)
	}
	for rows.Next() {
		var c struct {
			cid      int
			name     string
			dataType string
			notNull  int
			defaultV interface{}
			pk       int
		}
		rows.Scan(&c.cid, &c.name, &c.dataType, &c.notNull, &c.defaultV, &c.pk)
		cols = append(cols, c)
	}
	rows.Close()

	for _, c := range cols {
		if c.name == "id" && strings.Contains(strings.ToUpper(c.dataType), "INT") {
			fmt.Println("Migration not needed — scheduled_tasks.id is already INTEGER.")
			return
		}
	}

	fmt.Println("Starting migration: TEXT id → INTEGER AUTOINCREMENT")
	fmt.Println()

	// Step 1: Read all existing tasks with their TEXT IDs
	type taskRow struct {
		oldID       string
		projectPath string
		name        string
		cronExpr    string
		agentID     string
		prompt      string
		sessionID   string
		status       string
		repeatMode   string
		maxRuns      int
		lastRunAt    sql.NullTime
		nextRunAt    sql.NullTime
		runCount     int
		lastReadAt   sql.NullTime
		createdAt    string
		updatedAt    string
	}

	taskRows, err := db.Query(`
		SELECT id, project_path, name, cron_expr, agent_id, prompt, session_id,
			status, repeat_mode, max_runs, last_run_at, next_run_at, run_count,
			last_read_at, created_at, updated_at
		FROM scheduled_tasks ORDER BY created_at ASC`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to query tasks: %v\n", err)
		os.Exit(1)
	}

	var tasks []taskRow
	for taskRows.Next() {
		var t taskRow
		taskRows.Scan(&t.oldID, &t.projectPath, &t.name, &t.cronExpr, &t.agentID, &t.prompt, &t.sessionID,
			&t.status, &t.repeatMode, &t.maxRuns, &t.lastRunAt, &t.nextRunAt, &t.runCount,
			&t.lastReadAt, &t.createdAt, &t.updatedAt)
		tasks = append(tasks, t)
	}
	taskRows.Close()

	fmt.Printf("Found %d tasks to migrate.\n", len(tasks))

	// Step 2: Create new table
	_, err = db.Exec(`CREATE TABLE scheduled_tasks_new (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		project_path TEXT NOT NULL,
		name TEXT NOT NULL,
		cron_expr TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		prompt TEXT NOT NULL,
		session_id TEXT DEFAULT '',
		status TEXT DEFAULT 'active',
		repeat_mode TEXT DEFAULT 'unlimited',
		max_runs INTEGER DEFAULT 0,
		last_run_at DATETIME,
		next_run_at DATETIME,
		run_count INTEGER DEFAULT 0,
		last_read_at DATETIME,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create new table: %v\n", err)
		os.Exit(1)
	}

	// Step 3: Copy data with new auto-increment IDs and build mapping
	idMap := make(map[string]int64) // old TEXT ID → new INTEGER ID
	for _, t := range tasks {
		result, err := db.Exec(`
			INSERT INTO scheduled_tasks_new (project_path, name, cron_expr, agent_id, prompt, session_id,
				status, repeat_mode, max_runs, last_run_at, next_run_at, run_count,
				last_read_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			t.projectPath, t.name, t.cronExpr, t.agentID, t.prompt, t.sessionID,
			t.status, t.repeatMode, t.maxRuns, t.lastRunAt, t.nextRunAt, t.runCount,
			t.lastReadAt, t.createdAt, t.updatedAt)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to insert task %s: %v\n", t.oldID, err)
			os.Exit(1)
		}
		newID, _ := result.LastInsertId()
		idMap[t.oldID] = newID
		fmt.Printf("  %s → %d\n", t.oldID, newID)
	}

	// Step 4: Update task_executions.task_id
	// First, create a temporary mapping table for the UPDATE
	for oldID, newID := range idMap {
		_, err := db.Exec("UPDATE task_executions SET task_id = ? WHERE task_id = ?", strconv.FormatInt(newID, 10), oldID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to update task_executions for %s: %v\n", oldID, err)
			// Continue — non-fatal
		}
	}

	// Step 5: Recreate task_executions table with correct INTEGER type
	_, err = db.Exec("ALTER TABLE task_executions RENAME TO task_executions_old")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to rename task_executions: %v\n", err)
		os.Exit(1)
	}

	_, err = db.Exec(`CREATE TABLE task_executions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		task_id INTEGER NOT NULL,
		session_id TEXT NOT NULL,
		trigger_type TEXT NOT NULL DEFAULT 'auto',
		status TEXT NOT NULL DEFAULT 'completed',
		read_at DATETIME,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	)`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create new task_executions: %v\n", err)
		os.Exit(1)
	}

	_, err = db.Exec(`INSERT INTO task_executions (id, task_id, session_id, trigger_type, status, read_at, created_at)
		SELECT id, CAST(task_id AS INTEGER), session_id, trigger_type, status, read_at, created_at FROM task_executions_old`)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to copy task_executions data: %v\n", err)
		os.Exit(1)
	}

	_, err = db.Exec("DROP TABLE task_executions_old")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to drop old task_executions: %v\n", err)
	}

	// Step 6: Swap scheduled_tasks tables
	_, err = db.Exec("DROP TABLE scheduled_tasks")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to drop old scheduled_tasks: %v\n", err)
		os.Exit(1)
	}

	_, err = db.Exec("ALTER TABLE scheduled_tasks_new RENAME TO scheduled_tasks")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to rename new table: %v\n", err)
		os.Exit(1)
	}

	// Step 7: Recreate indexes
	db.Exec("CREATE INDEX IF NOT EXISTS idx_executions_task ON task_executions(task_id, created_at DESC)")
	db.Exec("CREATE INDEX IF NOT EXISTS idx_executions_session ON task_executions(session_id)")

	fmt.Println()
	fmt.Printf("Migration complete: %d tasks migrated.\n", len(tasks))
}
