package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"clawbench/internal/ai"
	"clawbench/internal/model"

	"github.com/robfig/cron/v3"
)

// GlobalScheduler is the singleton scheduler instance, set during startup.
var GlobalScheduler *Scheduler

// RunningExecution tracks a currently executing task instance.
type RunningExecution struct {
	ID          string
	TaskID      string
	CancelFunc  context.CancelFunc
	StartedAt   time.Time
	TriggerType string // "auto" | "manual"
}

// Scheduler manages cron-scheduled AI tasks.
type Scheduler struct {
	cron             *cron.Cron
	entries          map[string]cron.EntryID // task ID -> cron entry ID
	mu               sync.Mutex
	runningExecutions sync.Map // key: executionID, value: *RunningExecution
}

// NewScheduler creates a new Scheduler instance.
func NewScheduler() *Scheduler {
	return &Scheduler{
		cron:    cron.New(),
		entries: make(map[string]cron.EntryID),
	}
}

// Start begins the cron scheduler.
func (s *Scheduler) Start() {
	s.cron.Start()
	slog.Info("scheduler started")
}

// Stop halts the cron scheduler.
func (s *Scheduler) Stop() {
	s.cron.Stop()
	slog.Info("scheduler stopped")
}

// GetRunningExecutions returns the running execution views for a specific task.
func (s *Scheduler) GetRunningExecutions(taskID string) []model.RunningExecutionView {
	var result []model.RunningExecutionView
	s.runningExecutions.Range(func(key, value any) bool {
		exec := value.(*RunningExecution)
		if exec.TaskID == taskID {
			result = append(result, model.RunningExecutionView{
				ID:          exec.ID,
				StartedAt:   exec.StartedAt,
				TriggerType: exec.TriggerType,
			})
		}
		return true
	})
	return result
}

// GetRunningCounts returns a map of taskID -> running execution count.
func (s *Scheduler) GetRunningCounts() map[string]int {
	counts := make(map[string]int)
	s.runningExecutions.Range(func(key, value any) bool {
		exec := value.(*RunningExecution)
		counts[exec.TaskID]++
		return true
	})
	return counts
}

// HasRunningExecutions checks if a task has any running executions.
func (s *Scheduler) HasRunningExecutions(taskID string) bool {
	found := false
	s.runningExecutions.Range(func(key, value any) bool {
		if value.(*RunningExecution).TaskID == taskID {
			found = true
			return false
		}
		return true
	})
	return found
}

// CancelExecution cancels a specific running execution by its ID.
// Returns error if the execution is not found or already finished.
func (s *Scheduler) CancelExecution(executionID string) error {
	val, ok := s.runningExecutions.Load(executionID)
	if !ok {
		return fmt.Errorf("execution not found: %s", executionID)
	}
	exec := val.(*RunningExecution)
	exec.CancelFunc()
	slog.Info("cancelled running execution",
		slog.String("exec_id", executionID),
		slog.String("task_id", exec.TaskID),
	)
	return nil
}

// CancelAllExecutions cancels all running executions for a specific task.
func (s *Scheduler) CancelAllExecutions(taskID string) {
	s.runningExecutions.Range(func(key, value any) bool {
		exec := value.(*RunningExecution)
		if exec.TaskID == taskID {
			exec.CancelFunc()
			slog.Info("cancelled running execution for task",
				slog.String("exec_id", exec.ID),
				slog.String("task_id", taskID),
			)
		}
		return true
	})
}

// LoadTasksFromDB loads active tasks from the database and registers them.
// If projectPath is empty, loads tasks from all projects.
func (s *Scheduler) LoadTasksFromDB(projectPath string) error {
	tasks, err := GetTasks(projectPath)
	if err != nil {
		return err
	}
	for i := range tasks {
		task := &tasks[i]
		if task.Status != "active" {
			continue
		}
		if err := s.registerTask(task); err != nil {
			slog.Warn("failed to register task on load",
				slog.String("task_id", task.ID),
				slog.String("err", err.Error()),
			)
		}
	}
	return nil
}

// AddTask creates a new scheduled task, persists it, and registers it with cron.
func (s *Scheduler) AddTask(task *model.ScheduledTask) error {
	if task.ID == "" {
		task.ID = generateTaskID()
	}
	now := time.Now()
	task.CreatedAt = now
	task.UpdatedAt = now
	task.Status = "active"

	// Calculate next run time
	schedule, err := cron.ParseStandard(task.CronExpr)
	if err != nil {
		return fmt.Errorf("invalid cron expression: %w", err)
	}
	nextRun := schedule.Next(now)
	task.NextRunAt = &nextRun

	// Persist to database
	if err := saveTask(task); err != nil {
		return err
	}

	// Register with cron
	return s.registerTask(task)
}

// RemoveTask removes a task from cron and marks it as deleted in the database.
func (s *Scheduler) RemoveTask(id string) {
	s.mu.Lock()
	if entryID, ok := s.entries[id]; ok {
		s.cron.Remove(entryID)
		delete(s.entries, id)
	}
	s.mu.Unlock()

	DB.Exec("UPDATE scheduled_tasks SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
}

// PauseTask removes a task from cron but keeps it in the database as paused.
func (s *Scheduler) PauseTask(id string) {
	s.mu.Lock()
	if entryID, ok := s.entries[id]; ok {
		s.cron.Remove(entryID)
		delete(s.entries, id)
	}
	s.mu.Unlock()

	DB.Exec("UPDATE scheduled_tasks SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
}

// ResumeTask re-registers a paused task with cron.
func (s *Scheduler) ResumeTask(id string) error {
	task, err := GetTaskByID(id)
	if err != nil {
		return err
	}
	if task.Status != "paused" {
		return fmt.Errorf("task is not paused")
	}

	DB.Exec("UPDATE scheduled_tasks SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
	task.Status = "active"

	return s.registerTask(task)
}

// UpdateTask updates an existing task's configuration and re-registers if needed.

// TriggerTask runs a task immediately in a background goroutine, regardless of its status.
func (s *Scheduler) TriggerTask(id string) error {
	task, err := GetTaskByID(id)
	if err != nil {
		return fmt.Errorf("task not found: %w", err)
	}
	go s.executeTask(task, task.ProjectPath, "manual")
	return nil
}

// UpdateTask updates an existing task's configuration and re-registers if needed.
func (s *Scheduler) UpdateTask(task *model.ScheduledTask) error {
	// Update timestamp
	task.UpdatedAt = time.Now()

	// Recalculate next run time if cron expression changed
	schedule, err := cron.ParseStandard(task.CronExpr)
	if err != nil {
		return fmt.Errorf("invalid cron expression: %w", err)
	}
	nextRun := schedule.Next(time.Now())
	task.NextRunAt = &nextRun

	// If task is active (or reactivated from completed), remove old cron entry and re-register atomically
	if task.Status == "active" {
		s.mu.Lock()
		if entryID, ok := s.entries[task.ID]; ok {
			s.cron.Remove(entryID)
			delete(s.entries, task.ID)
		}
		// Re-register while holding lock to ensure atomicity
		if err := s.registerTaskLocked(task); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("failed to re-register task: %w", err)
		}
		s.mu.Unlock()
	} else if task.Status != "active" {
		// Remove from cron if task is not active (completed/paused/deleted)
		s.mu.Lock()
		if entryID, ok := s.entries[task.ID]; ok {
			s.cron.Remove(entryID)
			delete(s.entries, task.ID)
		}
		s.mu.Unlock()
	}

	// Persist to database
	if err := saveTask(task); err != nil {
		return err
	}

	slog.Info("updated task",
		slog.String("task_id", task.ID),
		slog.String("name", task.Name),
		slog.String("status", task.Status),
	)
	return nil
}

// registerTask adds a task's cron job to the scheduler.
func (s *Scheduler) registerTask(task *model.ScheduledTask) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.registerTaskLocked(task)
}

// registerTaskLocked adds a task's cron job to the scheduler.
// The caller must hold s.mu lock.
func (s *Scheduler) registerTaskLocked(task *model.ScheduledTask) error {
	schedule, err := cron.ParseStandard(task.CronExpr)
	if err != nil {
		return fmt.Errorf("invalid cron expression: %w", err)
	}

	// Capture task by value for the closure
	taskID := task.ID
	projectPath := task.ProjectPath

	entryID := s.cron.Schedule(schedule, cron.FuncJob(func() {
		// Reload task from DB to get latest state
		current, err := GetTaskByID(taskID)
		if err != nil || current.Status != "active" {
			return
		}
		s.executeTask(current, projectPath, "auto")
	}))

	// Lock is already held by caller
	s.entries[taskID] = entryID

	slog.Info("registered cron task",
		slog.String("task_id", taskID),
		slog.String("cron", task.CronExpr),
	)
	return nil
}

// executeTask runs a scheduled task by invoking the AI backend and inserting
// the result as an assistant message in the original session.
func (s *Scheduler) executeTask(task *model.ScheduledTask, projectPath string, triggerType string) {
	execID := generateExecutionID()

	slog.Info("executing scheduled task",
		slog.String("task_id", task.ID),
		slog.String("exec_id", execID),
		slog.String("name", task.Name),
	)

	agent, ok := model.Agents[task.AgentID]
	if !ok {
		slog.Error("agent not found for task", slog.String("agent_id", task.AgentID))
		return
	}

	backendName := agent.Backend
	if backendName == "" {
		backendName = "codebuddy"
	}

	// Build chat request — no session resume, standalone execution
	// ScheduledExecution flag prevents recursive task creation at the
	// handler level: even if the AI outputs a <schedule-proposal> tag,
	// the handler will not create a task from it.
	chatReq := ai.ChatRequest{
		Prompt:             task.Prompt,
		SessionID:          execID, // use executionID to identify this run
		WorkDir:            projectPath,
		SystemPrompt:       agent.SystemPrompt,
		Model:              agent.DefaultModelID(),
		Command:            agent.Command,
		AgentID:            task.AgentID,
		Resume:             false,
		ScheduledExecution: true,
	}

	// Execute AI backend (no timeout - let AI run indefinitely)
	ctx, cancel := context.WithCancel(context.Background())

	// Register running execution
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
		return
	}

	eventCh, err := backend.ExecuteStream(ctx, chatReq)
	if err != nil {
		slog.Error("failed to execute stream for task", slog.String("err", err.Error()))
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

	// If context was cancelled, skip persisting the execution result
	if ctx.Err() == context.Canceled {
		slog.Info("task execution cancelled, skipping result persistence",
			slog.String("task_id", task.ID),
			slog.String("exec_id", execID),
		)
		return
	}

	// Compute wall-clock duration and inject into metadata
	wallMs := int(time.Since(wallStart).Milliseconds())
	if responseMetadata == nil {
		responseMetadata = &ai.Metadata{}
	}
	responseMetadata.WallMs = wallMs

	// Build content JSON
	contentMap := map[string]any{"blocks": blocks}
	if responseMetadata != nil {
		contentMap["metadata"] = responseMetadata
	}
	contentJSON, _ := json.Marshal(contentMap)

	// Record execution directly in task_executions (no longer writes to chat_history)
	if err := AddTaskExecution(task.ID, string(contentJSON), triggerType); err != nil {
		slog.Error("failed to record task execution", slog.String("err", err.Error()))
	}

	// Update task execution stats
	now := time.Now()
	newStatus := task.Status

	// Check repeat mode — for "limited", read current DB value to decide completion
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
		// Task completed, remove from cron
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
		slog.String("exec_id", execID),
		slog.String("status", newStatus),
	)
}

// GetTasks retrieves all tasks for a project path. If projectPath is empty, retrieves all tasks.
func GetTasks(projectPath string) ([]model.ScheduledTask, error) {
	var tasks []model.ScheduledTask
	var query string
	var args []interface{}

	if projectPath == "" {
		query = `SELECT s.id, s.project_path, s.name, s.cron_expr, s.agent_id, s.prompt, s.session_id,
			s.status, s.repeat_mode, s.max_runs, s.last_run_at, s.next_run_at, s.run_count,
			s.last_read_at, s.created_at, s.updated_at,
			(SELECT COUNT(*) FROM task_executions e
			 WHERE e.task_id = s.id
			 AND (s.last_read_at IS NULL OR e.created_at > s.last_read_at)) AS unread_count
			FROM scheduled_tasks s WHERE s.status != 'deleted' ORDER BY s.created_at DESC`
	} else {
		query = `SELECT s.id, s.project_path, s.name, s.cron_expr, s.agent_id, s.prompt, s.session_id,
			s.status, s.repeat_mode, s.max_runs, s.last_run_at, s.next_run_at, s.run_count,
			s.last_read_at, s.created_at, s.updated_at,
			(SELECT COUNT(*) FROM task_executions e
			 WHERE e.task_id = s.id
			 AND (s.last_read_at IS NULL OR e.created_at > s.last_read_at)) AS unread_count
			FROM scheduled_tasks s WHERE s.project_path = ? AND s.status != 'deleted' ORDER BY s.created_at DESC`
		args = []interface{}{projectPath}
	}

	rows, err := DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var t model.ScheduledTask
		var lastRun, nextRun, lastRead sql.NullTime
		if err := rows.Scan(&t.ID, &t.ProjectPath, &t.Name, &t.CronExpr, &t.AgentID, &t.Prompt, &t.SessionID, &t.Status, &t.RepeatMode, &t.MaxRuns, &lastRun, &nextRun, &t.RunCount, &lastRead, &t.CreatedAt, &t.UpdatedAt, &t.UnreadCount); err != nil {
			return nil, err
		}
		if lastRun.Valid {
			t.LastRunAt = &lastRun.Time
		}
		if nextRun.Valid {
			t.NextRunAt = &nextRun.Time
		}
		if lastRead.Valid {
			t.LastReadAt = &lastRead.Time
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

// GetTaskByID retrieves a single task by its ID.
func GetTaskByID(id string) (*model.ScheduledTask, error) {
	var t model.ScheduledTask
	var lastRun, nextRun, lastRead sql.NullTime
	err := DB.QueryRow(
		`SELECT s.id, s.project_path, s.name, s.cron_expr, s.agent_id, s.prompt, s.session_id,
		s.status, s.repeat_mode, s.max_runs, s.last_run_at, s.next_run_at, s.run_count,
		s.last_read_at, s.created_at, s.updated_at,
		(SELECT COUNT(*) FROM task_executions e
		 WHERE e.task_id = s.id
		 AND (s.last_read_at IS NULL OR e.created_at > s.last_read_at)) AS unread_count
		FROM scheduled_tasks s WHERE s.id = ?`,
		id,
	).Scan(&t.ID, &t.ProjectPath, &t.Name, &t.CronExpr, &t.AgentID, &t.Prompt, &t.SessionID, &t.Status, &t.RepeatMode, &t.MaxRuns, &lastRun, &nextRun, &t.RunCount, &lastRead, &t.CreatedAt, &t.UpdatedAt, &t.UnreadCount)
	if err != nil {
		return nil, err
	}
	if lastRun.Valid {
		t.LastRunAt = &lastRun.Time
	}
	if nextRun.Valid {
		t.NextRunAt = &nextRun.Time
	}
	if lastRead.Valid {
		t.LastReadAt = &lastRead.Time
	}
	return &t, nil
}

// saveTask inserts or updates a task in the database.
func saveTask(task *model.ScheduledTask) error {
	_, err := DB.Exec(
		`INSERT INTO scheduled_tasks (id, project_path, name, cron_expr, agent_id, prompt, session_id, status, repeat_mode, max_runs, next_run_at, run_count, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name=?, cron_expr=?, agent_id=?, prompt=?, session_id=?, status=?, repeat_mode=?, max_runs=?, next_run_at=?, run_count=?, updated_at=CURRENT_TIMESTAMP`,
		task.ID, task.ProjectPath, task.Name, task.CronExpr, task.AgentID, task.Prompt, task.SessionID, task.Status, task.RepeatMode, task.MaxRuns, task.NextRunAt, task.RunCount, task.CreatedAt, task.UpdatedAt,
		task.Name, task.CronExpr, task.AgentID, task.Prompt, task.SessionID, task.Status, task.RepeatMode, task.MaxRuns, task.NextRunAt, task.RunCount,
	)
	return err
}

// AddTaskExecution records a task execution with its content directly in task_executions.
func AddTaskExecution(taskID string, content string, triggerType string) error {
	_, err := DB.Exec(
		"INSERT INTO task_executions (task_id, content, trigger_type) VALUES (?, ?, ?)",
		taskID, content, triggerType,
	)
	return err
}

// UpdateTaskLastRead updates the last_read_at timestamp for a task, clearing unread status.
func UpdateTaskLastRead(taskID string) error {
	_, err := DB.Exec(
		"UPDATE scheduled_tasks SET last_read_at = CURRENT_TIMESTAMP WHERE id = ?",
		taskID,
	)
	return err
}

// HasUnreadTasks checks if any task for the given project has unread executions.
func HasUnreadTasks(projectPath string) (bool, error) {
	var count int
	var err error
	if projectPath == "" {
		err = DB.QueryRow(
			`SELECT COUNT(*) FROM scheduled_tasks s
			 WHERE s.status != 'deleted'
			 AND (SELECT COUNT(*) FROM task_executions e
			      WHERE e.task_id = s.id
			      AND (s.last_read_at IS NULL OR e.created_at > s.last_read_at)) > 0`,
		).Scan(&count)
	} else {
		err = DB.QueryRow(
			`SELECT COUNT(*) FROM scheduled_tasks s
			 WHERE s.project_path = ? AND s.status != 'deleted'
			 AND (SELECT COUNT(*) FROM task_executions e
			      WHERE e.task_id = s.id
			      AND (s.last_read_at IS NULL OR e.created_at > s.last_read_at)) > 0`,
			projectPath,
		).Scan(&count)
	}
	return count > 0, err
}

// generateTaskID creates a unique ID for a scheduled task.
func generateTaskID() string {
	return generateUUID("task-", "scheduled_tasks", "id")
}

// generateExecutionID creates a unique ID for a task execution instance.
func generateExecutionID() string {
	return generateUUID("exec-", "task_executions", "id")
}
