# Pi Backend Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Pi (earendil-works/pi) as a first-class AI backend in ClawBench, using the same CLIBackend pattern as DeepSeek/Gemini/OpenCode.

**Architecture:** Pi runs as a CLI subprocess via `pi -p --mode json`, outputting NDJSON events (session, agent_start/end, turn_start/end, message_start/update/end, tool_execution_start/end). A new `PiStreamParser` maps Pi's event schema to ClawBench's `StreamEvent` types. Pi supports `--session <id>` for resume, `--append-system-prompt` for rules.md injection, and `--model` for model selection. Pi has an ExitPlanMode tool, so it should be wrapped in `AutoResumeBackend`.

**Tech Stack:** Go, existing ClawBench `CLIBackend`/`LineParser` interfaces, Pi CLI v0.74+

---

### Task 1: Create PiStreamParser

**Files:**
- Create: `internal/ai/pi_stream.go`
- Test: `internal/ai/pi_stream_test.go`

**Step 1: Write failing tests for PiStreamParser**

Create `internal/ai/pi_stream_test.go`:

```go
package ai

import (
	"encoding/json"
	"testing"
)

func TestPiStreamParser_SessionEvent(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"session","version":3,"id":"019e2110-274a-73ec-9e14-f1a7b5c13e6f","timestamp":"2026-05-13T11:19:27.307Z","cwd":"/home/user/project"}`
	p.ParseLine(line, ch)

	if p.GetCapturedSessionID() != "019e2110-274a-73ec-9e14-f1a7b5c13e6f" {
		t.Errorf("expected session ID, got %q", p.GetCapturedSessionID())
	}
}

func TestPiStreamParser_ThinkingDelta(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"The user wants me to say hello."},"message":{"role":"assistant"}}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "thinking" {
			t.Errorf("expected thinking event, got %q", evt.Type)
		}
		if evt.Content != "The user wants me to say hello." {
			t.Errorf("expected thinking content, got %q", evt.Content)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_TextDelta(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hello!"},"message":{"role":"assistant"}}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "content" {
			t.Errorf("expected content event, got %q", evt.Type)
		}
		if evt.Content != "Hello!" {
			t.Errorf("expected content 'Hello!', got %q", evt.Content)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_ToolcallEnd(t *testing.T) {
	p := &PiStreamParser{activeTools: make(map[string]*ToolCall)}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"/etc/hostname","limit":5}}},"message":{"role":"assistant"}}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "tool_use" {
			t.Errorf("expected tool_use event, got %q", evt.Type)
		}
		if evt.Tool.Name != "Read" {
			t.Errorf("expected normalized tool name 'Read', got %q", evt.Tool.Name)
		}
		if evt.Tool.ID != "call_1" {
			t.Errorf("expected tool ID 'call_1', got %q", evt.Tool.ID)
		}
		if !evt.Tool.Done {
			t.Error("expected Done=true for toolcall_end")
		}
		// Verify input field normalization: path -> file_path
		var input map[string]interface{}
		if err := json.Unmarshal([]byte(evt.Tool.Input), &input); err != nil {
			t.Fatalf("input is not valid JSON: %v", err)
		}
		if _, ok := input["file_path"]; !ok {
			t.Errorf("expected 'file_path' in input, got %v", input)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_ToolExecutionEnd(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":"xulongzhe-KLVL-WXX9"}]},"isError":false}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "tool_result" {
			t.Errorf("expected tool_result event, got %q", evt.Type)
		}
		if evt.Tool.ID != "call_1" {
			t.Errorf("expected tool ID 'call_1', got %q", evt.Tool.ID)
		}
		if evt.Tool.Output != "xulongzhe-KLVL-WXX9" {
			t.Errorf("expected output, got %q", evt.Tool.Output)
		}
		if evt.Tool.Status != "success" {
			t.Errorf("expected status 'success', got %q", evt.Tool.Status)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_ToolExecutionEndError(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"tool_execution_end","toolCallId":"call_2","toolName":"bash","result":{"content":[{"type":"text","text":"ls: cannot access '/nope': No such file"}]},"isError":true}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "tool_result" {
			t.Errorf("expected tool_result event, got %q", evt.Type)
		}
		if evt.Tool.Status != "error" {
			t.Errorf("expected status 'error', got %q", evt.Tool.Status)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_MessageEndMetadata(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"message_end","message":{"role":"assistant","usage":{"input":1396,"output":27,"cacheRead":0,"cacheWrite":0,"totalTokens":1423,"cost":{"input":0.004188,"output":0.000405,"cacheRead":0,"cacheWrite":0,"total":0.004593}},"stopReason":"stop","responseId":"resp_123"}}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "metadata" {
			t.Errorf("expected metadata event, got %q", evt.Type)
		}
		if evt.Meta.InputTokens != 1396 {
			t.Errorf("expected 1396 input tokens, got %d", evt.Meta.InputTokens)
		}
		if evt.Meta.OutputTokens != 27 {
			t.Errorf("expected 27 output tokens, got %d", evt.Meta.OutputTokens)
		}
		if evt.Meta.CostUSD != 0.004593 {
			t.Errorf("expected cost 0.004593, got %f", evt.Meta.CostUSD)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_AgentEndDone(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"agent_end","messages":[]}`
	p.ParseLine(line, ch)

	select {
	case evt := <-ch:
		if evt.Type != "done" {
			t.Errorf("expected done event, got %q", evt.Type)
		}
	default:
		t.Error("expected event on channel")
	}
}

func TestPiStreamParser_ErrorMessage(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"403 forbidden"}}`
	p.ParseLine(line, ch)

	found := false
	for {
		select {
		case evt := <-ch:
			if evt.Type == "error" && evt.Error == "403 forbidden" {
				found = true
			}
		default:
			goto done
		}
	}
done:
	if !found {
		t.Error("expected error event with message")
	}
}

func TestPiStreamParser_SkipsUnknownTypes(t *testing.T) {
	p := &PiStreamParser{}
	ch := make(chan StreamEvent, 10)
	line := `{"type":"compaction_start","reason":"context_window"}`
	p.ParseLine(line, ch)

	select {
	case <-ch:
		t.Error("should not emit event for unknown type")
	default:
		// expected
	}
}

func TestPiStreamParser_ToolcallDeltaAccumulates(t *testing.T) {
	p := &PiStreamParser{activeTools: make(map[string]*ToolCall)}
	ch := make(chan StreamEvent, 20)

	// Start tool call
	startLine := `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":1},"message":{"role":"assistant","content":[{"type":"toolCall","id":"call_abc","name":"read","arguments":{},"partialJson":"","index":1}]}}`
	p.ParseLine(startLine, ch)

	// Delta 1
	delta1 := `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\"path\": \"/etc/hosts\"}"},"message":{"role":"assistant","content":[{"type":"toolCall","id":"call_abc","name":"read","arguments":{},"partialJson":"{\"path\": \"/etc/hosts\"}","index":1}]}}`
	p.ParseLine(delta1, ch)

	// End tool call
	endLine := `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"call_abc","name":"read","arguments":{"path":"/etc/hosts"}}},"message":{"role":"assistant"}}`
	p.ParseLine(endLine, ch)

	// Drain channel, find the tool_use with Done=true
	found := false
	for {
		select {
		case evt := <-ch:
			if evt.Type == "tool_use" && evt.Tool.Done && evt.Tool.ID == "call_abc" {
				found = true
				if evt.Tool.Name != "Read" {
					t.Errorf("expected normalized name Read, got %q", evt.Tool.Name)
				}
			}
		default:
			goto done2
		}
	}
done2:
	if !found {
		t.Error("expected tool_use event with Done=true from toolcall_end")
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `go test ./internal/ai/ -run TestPiStreamParser -v`
Expected: Compilation errors — `PiStreamParser` undefined

**Step 3: Write PiStreamParser implementation**

Create `internal/ai/pi_stream.go`:

```go
package ai

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
)

// PiStreamEvent represents a single JSON line from `pi --mode json`.
// Fields are shared across event types — only relevant fields are populated per type.
type PiStreamEvent struct {
	Type                  string          `json:"type"`
	ID                    string          `json:"id"`                      // session event
	ToolCallID            string          `json:"toolCallId"`              // tool_execution_*
	ToolName              string          `json:"toolName"`                // tool_execution_*
	Args                  json.RawMessage `json:"args"`                    // tool_execution_start
	Result                *PiToolResult   `json:"result"`                  // tool_execution_end
	IsError               bool            `json:"isError"`                 // tool_execution_end
	AssistantMessageEvent *PiAssistantEvent `json:"assistantMessageEvent"` // message_update
	Message               json.RawMessage  `json:"message"`                // message_start/end/update
}

// PiAssistantEvent is the assistantMessageEvent within a message_update event.
type PiAssistantEvent struct {
	Type         string          `json:"type"`         // text_start, text_delta, text_end, thinking_start, thinking_delta, thinking_end, toolcall_start, toolcall_delta, toolcall_end, done, error
	ContentIndex int             `json:"contentIndex"` // index of the content block
	Delta        string          `json:"delta"`        // incremental text (text_delta, thinking_delta, toolcall_delta)
	Content      string          `json:"content"`      // full content (text_end, thinking_end)
	ToolCall     *PiToolCallRef  `json:"toolCall"`     // toolcall_end only
}

// PiToolCallRef is a tool call reference in a toolcall_end event.
type PiToolCallRef struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// PiToolResult is the result field in a tool_execution_end event.
type PiToolResult struct {
	Content []PiToolResultContent `json:"content"`
}

// PiToolResultContent is a content block in a tool result.
type PiToolResultContent struct {
	Type string `json:"type"` // "text"
	Text string `json:"text"`
}

// PiMessage is a minimal struct for extracting fields from message events.
type PiMessage struct {
	Role         string `json:"role"`
	StopReason   string `json:"stopReason"`
	ErrorMessage string `json:"errorMessage"`
	Usage        *PiUsage `json:"usage"`
}

// PiUsage is the usage field in a message event.
type PiUsage struct {
	Input       int     `json:"input"`
	Output      int     `json:"output"`
	CacheRead   int     `json:"cacheRead"`
	CacheWrite  int     `json:"cacheWrite"`
	TotalTokens int     `json:"totalTokens"`
	Cost        *PiCost `json:"cost"`
}

// PiCost is the cost breakdown in a usage event.
type PiCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// PiStreamParser parses JSON Lines output from `pi --mode json`.
type PiStreamParser struct {
	sessionID   string
	activeTools map[string]*ToolCall // tracks in-progress tool calls by ID
	toolInput   map[string]string    // accumulates partialJson for each tool call
}

// GetCapturedSessionID returns the session ID captured from the session header event.
func (p *PiStreamParser) GetCapturedSessionID() string {
	return p.sessionID
}

// ParseLine parses a single JSON line from Pi's --mode json output and sends
// StreamEvent(s) to the provided channel.
func (p *PiStreamParser) ParseLine(line string, ch chan<- StreamEvent) {
	var evt PiStreamEvent
	if err := json.Unmarshal([]byte(line), &evt); err != nil {
		slog.Debug("pi stream: skipping unparseable line", "line", line, "error", err)
		return
	}

	switch evt.Type {
	case "session":
		p.handleSession(evt, ch)
	case "message_update":
		p.handleMessageUpdate(evt, ch)
	case "message_end":
		p.handleMessageEnd(evt, ch)
	case "tool_execution_start":
		p.handleToolExecutionStart(evt, ch)
	case "tool_execution_end":
		p.handleToolExecutionEnd(evt, ch)
	case "agent_end":
		ch <- StreamEvent{Type: "done"}
	case "agent_start", "turn_start", "turn_end",
		"message_start", "tool_execution_update",
		"compaction_start", "compaction_end",
		"auto_retry_start", "auto_retry_end",
		"queue_update":
		// Silently skip — these don't map to StreamEvent types
	default:
		slog.Debug("pi stream: skipping unknown event type", "type", evt.Type)
	}
}

func (p *PiStreamParser) handleSession(evt PiStreamEvent, ch chan<- StreamEvent) {
	if evt.ID != "" {
		p.sessionID = evt.ID
		slog.Debug("pi stream: captured session ID", "session_id", evt.ID)
		ch <- StreamEvent{Type: "session_capture", Content: evt.ID}
	}
}

func (p *PiStreamParser) handleMessageUpdate(evt PiStreamEvent, ch chan<- StreamEvent) {
	ae := evt.AssistantMessageEvent
	if ae == nil {
		return
	}

	switch ae.Type {
	case "thinking_start", "thinking_delta":
		if ae.Delta != "" {
			ch <- StreamEvent{Type: "thinking", Content: ae.Delta}
		}
	case "thinking_end":
		// thinking_end carries the full content but we already streamed deltas;
		// no additional event needed

	case "text_start", "text_delta":
		if ae.Delta != "" {
			ch <- StreamEvent{Type: "content", Content: ae.Delta}
		}
	case "text_end":
		// text_end carries full content but already streamed via deltas

	case "toolcall_start":
		p.handleToolcallStart(ae, ch)
	case "toolcall_delta":
		p.handleToolcallDelta(ae, ch)
	case "toolcall_end":
		p.handleToolcallEnd(ae, ch)

	case "done":
		// message completion — handled by message_end instead

	case "error":
		// Error within assistant message
		slog.Debug("pi stream: assistant message error", "delta", ae.Delta)
	}
}

func (p *PiStreamParser) handleToolcallStart(ae *PiAssistantEvent, ch chan<- StreamEvent) {
	// Extract tool call info from the message content array
	// Pi puts partial tool call info in the message.content[index]
	// We need to parse the outer message to get the toolCall id/name
	if p.activeTools == nil {
		p.activeTools = make(map[string]*ToolCall)
	}
	if p.toolInput == nil {
		p.toolInput = make(map[string]string)
	}
	// toolcall_start doesn't have the full id/name yet in ae;
	// we parse it from the message field's content array
	// For now, just initialize tracking — the real info comes in toolcall_delta/end
}

func (p *PiStreamParser) handleToolcallDelta(ae *PiAssistantEvent, ch chan<- StreamEvent) {
	// Accumulate partial JSON for the tool call
	// The delta contains a fragment of the tool arguments JSON
	// We track it but don't emit events until toolcall_end
	if ae.Delta != "" && p.toolInput != nil {
		// We'll use contentIndex as a key since we may not have the ID yet
		key := fmt.Sprintf("idx_%d", ae.ContentIndex)
		p.toolInput[key] += ae.Delta
	}
}

func (p *PiStreamParser) handleToolcallEnd(ae *PiAssistantEvent, ch chan<- StreamEvent) {
	if ae.ToolCall == nil {
		return
	}

	tc := ae.ToolCall
	toolName := normalizeToolName(tc.Name)
	input := normalizePiInput(tc.Name, tc.Arguments)

	ch <- StreamEvent{
		Type: "tool_use",
		Tool: &ToolCall{
			Name:  toolName,
			ID:    tc.ID,
			Input: input,
			Done:  true,
		},
	}

	// Track for matching with tool_execution_end
	if p.activeTools == nil {
		p.activeTools = make(map[string]*ToolCall)
	}
	p.activeTools[tc.ID] = &ToolCall{
		Name:  toolName,
		ID:    tc.ID,
		Input: input,
		Done:  true,
	}
}

func (p *PiStreamParser) handleToolExecutionStart(evt PiStreamEvent, ch chan<- StreamEvent) {
	// tool_execution_start fires after toolcall_end when Pi actually runs the tool.
	// We already emitted tool_use from toolcall_end, so this is informational only.
	// No StreamEvent to emit — tool_use was already sent.
	slog.Debug("pi stream: tool execution started",
		"toolCallId", evt.ToolCallID,
		"toolName", evt.ToolName,
	)
}

func (p *PiStreamParser) handleToolExecutionEnd(evt PiStreamEvent, ch chan<- StreamEvent) {
	// Extract output text from result.content[].text
	var outputText strings.Builder
	if evt.Result != nil {
		for _, c := range evt.Result.Content {
			if c.Type == "text" {
				outputText.WriteString(c.Text)
			}
		}
	}

	status := ""
	if evt.IsError {
		status = "error"
	} else {
		status = "success"
	}

	ch <- StreamEvent{
		Type: "tool_result",
		Tool: &ToolCall{
			ID:     evt.ToolCallID,
			Output: truncateToolOutput(outputText.String()),
			Status: status,
		},
	}
}

func (p *PiStreamParser) handleMessageEnd(evt PiStreamEvent, ch chan<- StreamEvent) {
	var msg PiMessage
	if err := json.Unmarshal(evt.Message, &msg); err != nil {
		slog.Debug("pi stream: failed to parse message_end", "error", err)
		return
	}

	// Check for error
	if msg.StopReason == "error" && msg.ErrorMessage != "" {
		ch <- StreamEvent{Type: "error", Error: msg.ErrorMessage}
	}

	// Emit metadata if usage is present
	if msg.Usage != nil {
		costUSD := 0.0
		if msg.Usage.Cost != nil {
			costUSD = msg.Usage.Cost.Total
		}
		ch <- StreamEvent{
			Type: "metadata",
			Meta: &Metadata{
				InputTokens:  msg.Usage.Input,
				OutputTokens: msg.Usage.Output,
				CostUSD:      costUSD,
			},
		}
	}
}

// normalizePiInput normalizes tool input field names from Pi's native names
// to the canonical names expected by ClawBench frontend renderers.
//
// Pi tool field mappings:
//   - read: {path, limit} -> {file_path, limit}
//   - write: {path, content} -> {file_path, content}
//   - edit: {path, edits:[{oldText,newText}]} -> {file_path, edits:[{old_string,new_string}]}
//   - bash: {command} -> {command} (no change)
func normalizePiInput(toolName string, rawInput json.RawMessage) string {
	remaps := map[string]string{
		"filePath": "file_path",
	}

	switch toolName {
	case "read", "write":
		remaps["path"] = "file_path"
	case "edit":
		remaps["path"] = "file_path"
		remaps["oldText"] = "old_string"
		remaps["newText"] = "new_string"
	}

	normalized, err := normalizeToolInput(rawInput, remaps)
	if err != nil {
		return string(rawInput)
	}
	return string(normalized)
}
```

**Step 4: Run tests to verify they pass**

Run: `go test ./internal/ai/ -run TestPiStreamParser -v`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add internal/ai/pi_stream.go internal/ai/pi_stream_test.go
git commit -m "feat: add PiStreamParser for pi --mode json output"
```

---

### Task 2: Create Pi CLIBackend instance and buildArgs

**Files:**
- Create: `internal/ai/pi.go`
- Test: `internal/ai/pi_test.go`

**Step 1: Write failing test for buildPiStreamArgs**

Create `internal/ai/pi_test.go`:

```go
package ai

import (
	"strings"
	"testing"
)

func TestBuildPiStreamArgs_NewSession(t *testing.T) {
	req := ChatRequest{
		Prompt:      "hello world",
		WorkDir:     "/home/user/project",
		SystemPrompt: "You are helpful.",
		Model:       "claude-sonnet-4-6",
	}
	args := buildPiStreamArgs(req)

	expected := []string{"-p", "--mode", "json", "--no-session", "--no-context-files",
		"--append-system-prompt", "You are helpful.",
		"--model", "claude-sonnet-4-6",
		"--add-dir", "/home/user/project",
		"hello world",
	}

	if len(args) != len(expected) {
		t.Errorf("expected %d args, got %d: %v", len(expected), len(args), args)
	}
	for i, exp := range expected {
		if i < len(args) && args[i] != exp {
			t.Errorf("arg[%d]: expected %q, got %q", i, exp, args[i])
		}
	}
}

func TestBuildPiStreamArgs_ResumeSession(t *testing.T) {
	req := ChatRequest{
		Prompt:    "continue the task",
		SessionID: "019e211f-b703-753c-b34a-c5c90fa1ab5f",
		Resume:    true,
		WorkDir:   "/home/user/project",
	}
	args := buildPiStreamArgs(req)

	argStr := strings.Join(args, " ")
	if !strings.Contains(argStr, "--session") {
		t.Error("expected --session flag for resume")
	}
	if !strings.Contains(argStr, "019e211f-b703-753c-b34a-c5c90fa1ab5f") {
		t.Error("expected session ID in args")
	}
	if strings.Contains(argStr, "--no-session") {
		t.Error("should not have --no-session for resume")
	}
}

func TestBuildPiStreamArgs_ScheduledExecution(t *testing.T) {
	req := ChatRequest{
		Prompt:             "run scheduled task",
		WorkDir:            "/home/user/project",
		ScheduledExecution: true,
	}
	args := buildPiStreamArgs(req)

	argStr := strings.Join(args, " ")
	if !strings.Contains(argStr, "--no-session") {
		t.Error("expected --no-session for scheduled execution")
	}
}

func TestBuildPiStreamArgs_NoModel(t *testing.T) {
	req := ChatRequest{
		Prompt:  "hello",
		WorkDir: "/home/user/project",
	}
	args := buildPiStreamArgs(req)

	argStr := strings.Join(args, " ")
	if strings.Contains(argStr, "--model") {
		t.Error("should not have --model when no model specified")
	}
}

func TestBuildPiStreamArgs_CustomCommand(t *testing.T) {
	req := ChatRequest{
		Prompt:  "hello",
		WorkDir: "/home/user/project",
		Command: "/usr/local/bin/pi",
	}
	args := buildPiStreamArgs(req)

	// Command override is handled by CLIBackend, not buildArgs
	// Just verify args don't contain the command path
	for _, arg := range args {
		if arg == "/usr/local/bin/pi" {
			t.Error("command path should not be in args, handled by CLIBackend")
		}
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `go test ./internal/ai/ -run TestBuildPiStreamArgs -v`
Expected: Compilation errors — `buildPiStreamArgs` undefined

**Step 3: Write Pi CLIBackend instance**

Create `internal/ai/pi.go`:

```go
package ai

// piBackend is the CLIBackend instance for Pi coding agent CLI.
var piBackend = &CLIBackend{
	name:           "pi",
	defaultCommand: "pi",
	buildArgs:      buildPiStreamArgs,
	newParser:      func() LineParser { return &PiStreamParser{} },
	filterLine:     nil, // skip empty lines only (default)
	preStart:       nil, // prompt is passed as positional argument
}

// buildPiStreamArgs constructs the CLI arguments for Pi streaming mode.
//
// Command: pi -p --mode json [--no-session] [--no-context-files] [flags] "prompt"
//
// Supported flags:
//   --append-system-prompt <text>  Append to system prompt (preserves Pi's built-in prompt)
//   --model <pattern>              Model pattern or ID (e.g. "claude-sonnet-4-6", "anthropic/claude-sonnet-4-6:high")
//   --session <id>                 Resume specific session by UUID
//   --continue                     Resume most recent session (fallback when no SessionID)
//   --add-dir <dir>                Add working directory for file operations
func buildPiStreamArgs(req ChatRequest) []string {
	args := []string{
		"-p",
		"--mode", "json",
	}

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

	// System prompt — use --append-system-prompt to preserve Pi's built-in
	// coding assistant prompt and add ClawBench's rules.md on top.
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
```

**Step 4: Run tests to verify they pass**

Run: `go test ./internal/ai/ -run TestBuildPiStreamArgs -v`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add internal/ai/pi.go internal/ai/pi_test.go
git commit -m "feat: add Pi CLIBackend and buildPiStreamArgs"
```

---

### Task 3: Register Pi backend in factory and discovery

**Files:**
- Modify: `internal/ai/factory.go`
- Modify: `internal/model/discovery.go`

**Step 1: Add Pi case to NewBackend switch**

In `internal/ai/factory.go`, before the `default:` case (around line 25), add:

```go
case "pi":
    return &AutoResumeBackend{inner: piBackend}, nil
```

Also update the error message in the `default:` case to include `pi` in the supported list:
Change `"unsupported backend type: %s (supported: claude, codebuddy, opencode, gemini, codex, qoder, vecli, deepseek)"`
To `"unsupported backend type: %s (supported: claude, codebuddy, opencode, gemini, codex, qoder, vecli, deepseek, pi)"`

**Step 2: Add Pi to BackendRegistry**

In `internal/model/discovery.go`, add a new entry after the deepseek entry (around line 45), before the closing `}`:

```go
{ID: "pi", Backend: "pi", DefaultCmd: "pi", Name: "Pi", Icon: "🥧", Specialty: "极简编程智能体",
    ListModelsCmd: []string{"--list-models"}, ParseModels: ParsePiModels},
```

**Step 3: Implement ParsePiModels**

In `internal/model/discovery.go`, add a new function after the existing `ParseDeepSeekModels`:

```go
// ParsePiModels parses the output of `pi --list-models` into a list of AgentModel.
// Output format:
//
//	provider        model                       context  max-out  thinking  images
//	anthropic       claude-sonnet-4-6           1M       64K      yes       yes
//	openai          gpt-4o                      128K     4.1K     no        yes
func ParsePiModels(output string) []AgentModel {
	var models []AgentModel
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		provider := fields[0]
		modelID := fields[1]
		// Skip header line
		if provider == "provider" || modelID == "model" {
			continue
		}
		// Prefix with provider for disambiguation
		fullID := provider + "/" + modelID
		models = append(models, AgentModel{
			ID:   fullID,
			Name: modelID,
		})
	}
	return models
}
```

**Step 4: Run existing factory and discovery tests**

Run: `go test ./internal/ai/ -run TestNewBackend -v`
Run: `go test ./internal/model/ -run TestParse -v`
Expected: All existing tests still PASS; Pi backend recognized

**Step 5: Write a test for ParsePiModels**

In `internal/model/discovery_test.go` (or wherever existing ParseXxxModels tests are), add:

```go
func TestParsePiModels(t *testing.T) {
	output := `provider        model                       context  max-out  thinking  images
anthropic       claude-sonnet-4-6           1M       64K      yes       yes
anthropic       claude-opus-4-6             1M       128K     yes       yes
openai          gpt-4o                      128K     4.1K     no        yes
minimax         MiniMax-M2.7                204.8K   131.1K   yes       no`
	models := ParsePiModels(output)
	if len(models) != 4 {
		t.Fatalf("expected 4 models, got %d", len(models))
	}
	if models[0].ID != "anthropic/claude-sonnet-4-6" {
		t.Errorf("expected 'anthropic/claude-sonnet-4-6', got %q", models[0].ID)
	}
	if models[0].Name != "claude-sonnet-4-6" {
		t.Errorf("expected name 'claude-sonnet-4-6', got %q", models[0].Name)
	}
	if models[3].ID != "minimax/MiniMax-M2.7" {
		t.Errorf("expected 'minimax/MiniMax-M2.7', got %q", models[3].ID)
	}
}
```

**Step 6: Run the new test**

Run: `go test ./internal/model/ -run TestParsePiModels -v`
Expected: PASS

**Step 7: Commit**

```bash
git add internal/ai/factory.go internal/model/discovery.go
git commit -m "feat: register Pi backend in factory and discovery"
```

---

### Task 4: Create Pi agent YAML config

**Files:**
- Create: `config/agents/pi.yaml`
- Create: `config/agents/pi.yaml.example`

**Step 1: Create pi.yaml**

```yaml
id: pi
name: Pi
icon: 🥧
specialty: 极简编程智能体 — 4 工具核心 + TypeScript 扩展生态
backend: pi
models:
  - id: anthropic/claude-sonnet-4-6
    name: Claude Sonnet 4.6
    default: true
  - id: anthropic/claude-opus-4-6
    name: Claude Opus 4.6
system_prompt: |
  You are a versatile assistant powered by Pi, capable of handling code, documentation, operations, research, and various tasks.
```

**Step 2: Create pi.yaml.example**

Same content as pi.yaml (follows existing pattern in the repo).

**Step 3: Commit**

```bash
git add config/agents/pi.yaml config/agents/pi.yaml.example
git commit -m "feat: add Pi agent YAML config"
```

---

### Task 5: Integration test — full stream parse

**Files:**
- Modify: `internal/ai/pi_stream_test.go`

**Step 1: Add a full-stream integration test**

Add to `internal/ai/pi_stream_test.go`:

```go
func TestPiStreamParser_FullStreamWithToolUse(t *testing.T) {
	p := &PiStreamParser{activeTools: make(map[string]*ToolCall), toolInput: make(map[string]string)}
	ch := make(chan StreamEvent, 100)

	lines := []string{
		`{"type":"session","version":3,"id":"019e211b-95a0-747e-9805-b9ba8c401d08","timestamp":"2026-05-13T11:31:56.449Z","cwd":"/home/user/project"}`,
		`{"type":"agent_start"}`,
		`{"type":"turn_start"}`,
		`{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"read /etc/hostname"}],"timestamp":1}}`,
		`{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"read /etc/hostname"}],"timestamp":1}}`,
		`{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"stop"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"I'll read the file."},"message":{"role":"assistant"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"id":"call_1","name":"read","arguments":{"path":"/etc/hostname"}}},"message":{"role":"assistant"}}`,
		`{"type":"message_end","message":{"role":"assistant","stopReason":"toolUse"}}`,
		`{"type":"tool_execution_start","toolCallId":"call_1","toolName":"read","args":{"path":"/etc/hostname"}}`,
		`{"type":"tool_execution_end","toolCallId":"call_1","toolName":"read","result":{"content":[{"type":"text","text":"myhost"}]},"isError":false}`,
		`{"type":"turn_end"}`,
		`{"type":"turn_start"}`,
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"The hostname is myhost"},"message":{"role":"assistant"}}`,
		`{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":20,"totalTokens":120,"cost":{"input":0.001,"output":0.0003,"total":0.0013}},"stopReason":"stop"}}`,
		`{"type":"agent_end","messages":[]}`,
	}

	for _, line := range lines {
		p.ParseLine(line, ch)
	}

	// Drain and verify event sequence
	var events []StreamEvent
	for {
		select {
		case evt := <-ch:
			events = append(events, evt)
		default:
			goto verify
		}
	}
verify:

	// Expected event types in order
	expected := []string{"session_capture", "thinking", "tool_use", "tool_result", "content", "metadata", "done"}
	if len(events) < len(expected) {
		t.Fatalf("expected at least %d events, got %d", len(expected), len(events))
	}

	eventTypes := make([]string, 0, len(events))
	for _, e := range events {
		eventTypes = append(eventTypes, e.Type)
	}

	for i, exp := range expected {
		found := false
		for _, actual := range eventTypes {
			if actual == exp {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing expected event type %q in %v", exp, eventTypes)
		}
	}

	// Verify session ID captured
	if p.GetCapturedSessionID() != "019e211b-95a0-747e-9805-b9ba8c401d08" {
		t.Errorf("session ID not captured correctly, got %q", p.GetCapturedSessionID())
	}

	// Verify tool_use normalization
	for _, e := range events {
		if e.Type == "tool_use" && e.Tool != nil {
			if e.Tool.Name != "Read" {
				t.Errorf("expected tool name 'Read', got %q", e.Tool.Name)
			}
			if e.Tool.ID != "call_1" {
				t.Errorf("expected tool ID 'call_1', got %q", e.Tool.ID)
			}
		}
		if e.Type == "tool_result" && e.Tool != nil {
			if e.Tool.Output != "myhost" {
				t.Errorf("expected tool output 'myhost', got %q", e.Tool.Output)
			}
			if e.Tool.Status != "success" {
				t.Errorf("expected tool status 'success', got %q", e.Tool.Status)
			}
		}
	}
}
```

**Step 2: Run all Pi tests**

Run: `go test ./internal/ai/ -run TestPi -v`
Expected: All tests PASS

**Step 3: Run full ai package tests to ensure no regressions**

Run: `go test ./internal/ai/ -v`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add internal/ai/pi_stream_test.go
git commit -m "test: add Pi full-stream integration test"
```

---

### Task 6: End-to-end validation

**Step 1: Build the project**

Run: `./build.sh`
Expected: Successful build

**Step 2: Start dev server**

Run: `./dev-server.sh`
Expected: Server starts, Pi agent appears in agent list

**Step 3: Test via API**

```bash
# Verify Pi is in agent list
curl -s http://localhost:20002/api/agents | python3 -m json.tool | grep -A5 '"id": "pi"'

# Test a simple Pi chat (requires pi CLI installed and models.json configured)
curl -s -X POST http://localhost:20002/api/ai/chat \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"pi","message":"say hello in one word"}'
```

Expected: Pi responds with streaming SSE events including content, metadata, done.

**Step 4: Commit final state (if any fixes needed)**

```bash
git add -A
git commit -m "feat: complete Pi backend integration"
```
