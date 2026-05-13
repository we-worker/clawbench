package ai

// piBackend is the CLIBackend instance for Pi CLI.
var piBackend = &CLIBackend{
	name:           "pi",
	defaultCommand: "pi",
	buildArgs:      buildPiStreamArgs,
	newParser:      func() LineParser { return &PiStreamParser{} },
	filterLine:     nil,
	preStart:       nil,
}

// buildPiStreamArgs constructs the CLI arguments for Pi streaming.
//
// Command: pi -p --mode json [flags] "prompt"
//
// Supported flags:
//   --session <id>              Resume a specific session
//   --continue                  Continue the most recent session
//   --no-session                Start a new session (no persistence)
//   --no-context-files          Skip AGENTS.md / CLAUDE.md discovery
//   --append-system-prompt <text> Append to Pi's built-in system prompt
//   --model <model>             Override model
//   --add-dir <dir>             Add working directory
func buildPiStreamArgs(req ChatRequest) []string {
	args := []string{"-p", "--mode", "json"}

	// Session management
	if req.Resume && req.SessionID != "" {
		args = append(args, "--session", req.SessionID)
	} else if req.Resume {
		args = append(args, "--continue")
	} else {
		args = append(args, "--no-session")
	}

	// Skip AGENTS.md / CLAUDE.md discovery — ClawBench injects its own rules
	args = append(args, "--no-context-files")

	// System prompt — use --append-system-prompt to preserve Pi's built-in prompt
	if req.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", req.SystemPrompt)
	}

	// Model override
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}

	// Working directory
	if req.WorkDir != "" {
		args = append(args, "--add-dir", req.WorkDir)
	}

	// Prompt is the last positional argument
	args = append(args, req.Prompt)

	return args
}
