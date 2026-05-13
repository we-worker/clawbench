package ai

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildPiStreamArgs_NewSession(t *testing.T) {
	req := ChatRequest{
		Prompt:       "hello world",
		SystemPrompt: "you are helpful",
		Model:        "pi-4",
		WorkDir:      "/home/user/project",
		Resume:       false,
	}
	args := buildPiStreamArgs(req)

	// Base args
	assert.Equal(t, "-p", args[0])
	assert.Equal(t, "--mode", args[1])
	assert.Equal(t, "json", args[2])

	// New session → --no-session
	assert.Contains(t, args, "--no-session")

	// Skip AGENTS.md discovery
	assert.Contains(t, args, "--no-context-files")

	// System prompt
	assert.Contains(t, args, "--append-system-prompt")
	idx := indexOf(args, "--append-system-prompt")
	assert.Equal(t, "you are helpful", args[idx+1])

	// Model
	assert.Contains(t, args, "--model")
	idx = indexOf(args, "--model")
	assert.Equal(t, "pi-4", args[idx+1])

	// Working directory
	assert.Contains(t, args, "--add-dir")
	idx = indexOf(args, "--add-dir")
	assert.Equal(t, "/home/user/project", args[idx+1])

	// Prompt is last
	assert.Equal(t, "hello world", args[len(args)-1])

	// NOT resuming
	assert.NotContains(t, args, "--session")
	assert.NotContains(t, args, "--continue")
}

func TestBuildPiStreamArgs_ResumeSession(t *testing.T) {
	req := ChatRequest{
		Prompt:   "continue this",
		SessionID: "sess-123",
		Resume:   true,
	}
	args := buildPiStreamArgs(req)

	// Resume with session ID → --session <id>
	assert.Contains(t, args, "--session")
	idx := indexOf(args, "--session")
	assert.Equal(t, "sess-123", args[idx+1])

	// NOT --no-session or --continue
	assert.NotContains(t, args, "--no-session")
	assert.NotContains(t, args, "--continue")
}

func TestBuildPiStreamArgs_ResumeContinue(t *testing.T) {
	req := ChatRequest{
		Prompt: "keep going",
		Resume: true,
	}
	args := buildPiStreamArgs(req)

	// Resume without session ID → --continue
	assert.Contains(t, args, "--continue")

	// NOT --session or --no-session
	assert.NotContains(t, args, "--session")
	assert.NotContains(t, args, "--no-session")
}

func TestBuildPiStreamArgs_ScheduledExecution(t *testing.T) {
	req := ChatRequest{
		Prompt:             "scheduled task",
		ScheduledExecution: true,
		Resume:             false,
	}
	args := buildPiStreamArgs(req)

	// Scheduled = new session → --no-session
	assert.Contains(t, args, "--no-session")
	assert.NotContains(t, args, "--session")
	assert.NotContains(t, args, "--continue")
}

func TestBuildPiStreamArgs_NoModel(t *testing.T) {
	req := ChatRequest{
		Prompt: "hello",
		Model:  "",
	}
	args := buildPiStreamArgs(req)

	assert.NotContains(t, args, "--model")
}

func TestBuildPiStreamArgs_NoSystemPrompt(t *testing.T) {
	req := ChatRequest{
		Prompt:       "hello",
		SystemPrompt: "",
	}
	args := buildPiStreamArgs(req)

	assert.NotContains(t, args, "--append-system-prompt")
}

// indexOf returns the index of the first occurrence of target in slice, or -1.
func indexOf(slice []string, target string) int {
	for i, v := range slice {
		if v == target {
			return i
		}
	}
	return -1
}

func TestPiBackendDefinition(t *testing.T) {
	assert.Equal(t, "pi", piBackend.name)
	assert.Equal(t, "pi", piBackend.defaultCommand)
	assert.NotNil(t, piBackend.buildArgs)
	assert.NotNil(t, piBackend.newParser)

	// newParser should return a *PiStreamParser
	parser := piBackend.newParser()
	assert.NotNil(t, parser)
	_, ok := parser.(*PiStreamParser)
	assert.True(t, ok, "expected *PiStreamParser, got %T", parser)

	// filterLine and preStart should be nil
	assert.Nil(t, piBackend.filterLine)
	assert.Nil(t, piBackend.preStart)
}
