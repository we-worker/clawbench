package cli

import (
	"os"
	"testing"

	"clawbench/internal/model"

	"github.com/stretchr/testify/assert"
)

func TestRunTaskCommand_NoArgs(t *testing.T) {
	// No args now prints help and returns 0
	exitCode := RunTaskCommand([]string{})
	assert.Equal(t, 0, exitCode)
}

func TestRunTaskCommand_HelpFlag(t *testing.T) {
	exitCode := RunTaskCommand([]string{"--help"})
	assert.Equal(t, 0, exitCode)
}

func TestRunTaskCommand_ShortHelpFlag(t *testing.T) {
	exitCode := RunTaskCommand([]string{"-h"})
	assert.Equal(t, 0, exitCode)
}

func TestRunTaskCommand_UnknownSubcommand(t *testing.T) {
	exitCode := RunTaskCommand([]string{"foo"})
	assert.Equal(t, 1, exitCode)
}

func TestCreateTask_MissingFields(t *testing.T) {
	exitCode := RunTaskCommand([]string{
		"create",
		"--name", "Test Task",
	})
	assert.Equal(t, 1, exitCode)
}

func TestCreateTask_ScheduledExecution(t *testing.T) {
	os.Setenv("CLAWBENCH_SCHEDULED", "1")
	defer os.Unsetenv("CLAWBENCH_SCHEDULED")

	exitCode := RunTaskCommand([]string{
		"create",
		"--name", "Test Task",
		"--cron", "0 9 * * *",
		"--agent", "codebuddy",
		"--prompt", "Test",
	})
	assert.Equal(t, 1, exitCode)
}

func TestCreateTask_LimitedRepeatWithoutMaxRuns(t *testing.T) {
	exitCode := RunTaskCommand([]string{
		"create",
		"--name", "Test Task",
		"--cron", "0 9 * * *",
		"--agent", "codebuddy",
		"--prompt", "Test",
		"--repeat", "limited",
	})
	assert.Equal(t, 1, exitCode)
}

func TestCreateTask_ServerNotReachable(t *testing.T) {
	tmpDir := t.TempDir()
	model.BinDir = tmpDir
	model.ConfigInstance = model.Config{
		WatchDir: tmpDir,
		Port:     59999,
	}

	exitCode := RunTaskCommand([]string{
		"create",
		"--name", "Test Task",
		"--cron", "0 9 * * *",
		"--agent", "codebuddy",
		"--prompt", "Test",
	})
	assert.Equal(t, 1, exitCode)
}

func TestDeleteTask_NoTaskID(t *testing.T) {
	exitCode := RunTaskCommand([]string{"delete"})
	assert.Equal(t, 1, exitCode)
}

func TestPauseTask_NoTaskID(t *testing.T) {
	exitCode := RunTaskCommand([]string{"pause"})
	assert.Equal(t, 1, exitCode)
}

func TestResumeTask_NoTaskID(t *testing.T) {
	exitCode := RunTaskCommand([]string{"resume"})
	assert.Equal(t, 1, exitCode)
}

func TestTriggerTask_NoTaskID(t *testing.T) {
	exitCode := RunTaskCommand([]string{"trigger"})
	assert.Equal(t, 1, exitCode)
}

func TestUpdateTask_NoTaskID(t *testing.T) {
	exitCode := RunTaskCommand([]string{"update"})
	assert.Equal(t, 1, exitCode)
}

func TestUpdateTask_InvalidRepeat(t *testing.T) {
	exitCode := RunTaskCommand([]string{
		"update", "some-id",
		"--repeat", "invalid",
	})
	assert.Equal(t, 1, exitCode)
}

func TestCreateTask_InvalidRepeat(t *testing.T) {
	exitCode := RunTaskCommand([]string{
		"create",
		"--name", "Test",
		"--cron", "0 9 * * *",
		"--agent", "codebuddy",
		"--prompt", "Test",
		"--repeat", "invalid",
	})
	assert.Equal(t, 1, exitCode)
}
