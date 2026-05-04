package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"clawbench/internal/ai"
	"clawbench/internal/service"

	"github.com/stretchr/testify/assert"
)

// parseSSEEvents splits an SSE response body into individual event+data pairs.
func parseSSEEvents(body string) []map[string]string {
	var events []map[string]string
	parts := strings.Split(body, "\n\n")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		entry := map[string]string{}
		lines := strings.Split(part, "\n")
		for _, line := range lines {
			if strings.HasPrefix(line, "event: ") {
				entry["event"] = strings.TrimPrefix(line, "event: ")
			} else if strings.HasPrefix(line, "data: ") {
				entry["data"] = strings.TrimPrefix(line, "data: ")
			}
		}
		if _, ok := entry["event"]; ok {
			events = append(events, entry)
		}
	}
	return events
}

// setupStreamSession creates a running session with a stream channel for testing.
func setupStreamSession(sessionID string) chan ai.StreamEvent {
	service.SetSessionRunning(sessionID, true)
	ch := service.RegisterSessionStream(sessionID)
	return ch
}

// cleanupStreamSession tears down a test session.
func cleanupStreamSession(sessionID string) {
	service.UnregisterSessionStream(sessionID)
	service.SetSessionRunning(sessionID, false)
	service.UnregisterSessionCancel(sessionID)
}

func TestAIChatStream_MethodNotAllowed(t *testing.T) {
	req := newRequest(t, http.MethodPost, "/api/ai/chat/stream", nil)
	w := callHandler(AIChatStream, req)
	assertStatus(t, w, http.StatusMethodNotAllowed)
}

func TestAIChatStream_MissingProjectCookie(t *testing.T) {
	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id=s1", nil)
	w := callHandler(AIChatStream, req)
	assertStatus(t, w, http.StatusForbidden)
}

func TestAIChatStream_MissingSessionID(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream", nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)
	assertStatus(t, w, http.StatusBadRequest)
}

func TestAIChatStream_SessionNotRunning(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id=not-running", nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "text/event-stream", w.Header().Get("Content-Type"))
	events := parseSSEEvents(w.Body.String())
	assert.Len(t, events, 1)
	assert.Equal(t, "error", events[0]["event"])
	assert.Contains(t, events[0]["data"], "会话未在运行")
}

func TestAIChatStream_NoStreamChannel(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	service.SetSessionRunning("no-stream", true)
	defer service.SetSessionRunning("no-stream", false)

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id=no-stream", nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	assert.Equal(t, http.StatusOK, w.Code)
	events := parseSSEEvents(w.Body.String())
	assert.Len(t, events, 1)
	assert.Equal(t, "error", events[0]["event"])
	assert.Contains(t, events[0]["data"], "未找到会话流")
}

func TestAIChatStream_ContentEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-content"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "content", Content: "hello world"}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "content", events[0]["event"])
	var data map[string]string
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "hello world", data["content"])
	assert.Equal(t, "done", events[1]["event"])
}

func TestAIChatStream_ThinkingEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-thinking"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "thinking", Content: "let me think..."}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "thinking", events[0]["event"])
	var data map[string]string
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "let me think...", data["text"])
}

func TestAIChatStream_ToolUseEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-tooluse"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{
			Type: "tool_use",
			Tool: &ai.ToolCall{Name: "Read", ID: "t1", Input: `{"file_path":"/foo.go"}`, Done: true},
		}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "tool_use", events[0]["event"])
	var data map[string]any
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "Read", data["name"])
	assert.Equal(t, "t1", data["id"])
	assert.Equal(t, true, data["done"])
	input := data["input"].(map[string]any)
	assert.Equal(t, "/foo.go", input["file_path"])
}

func TestAIChatStream_ToolUseEvent_EmptyInput(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-tooluse-empty"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{
			Type: "tool_use",
			Tool: &ai.ToolCall{Name: "Bash", ID: "t2", Input: "", Done: false},
		}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "tool_use", events[0]["event"])
	var data map[string]any
	json.Unmarshal([]byte(events[0]["data"]), &data)
	input := data["input"].(map[string]any)
	assert.Empty(t, input)
}

func TestAIChatStream_ToolUseEvent_NilTool(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-tooluse-nil"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "tool_use", Tool: nil}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Len(t, events, 1)
	assert.Equal(t, "done", events[0]["event"])
}

func TestAIChatStream_MetadataEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-metadata"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{
			Type: "metadata",
			Meta: &ai.Metadata{Model: "gpt-4", InputTokens: 100, OutputTokens: 50},
		}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "metadata", events[0]["event"])
	var data map[string]any
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "gpt-4", data["model"])
}

func TestAIChatStream_DoneEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-done"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Len(t, events, 1)
	assert.Equal(t, "done", events[0]["event"])
	assert.Equal(t, "{}", events[0]["data"])
}

func TestAIChatStream_CancelledEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-cancelled"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "cancelled"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "cancelled", events[0]["event"])
	assert.Contains(t, events[0]["data"], "cancelled")
}

func TestAIChatStream_ErrorEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-error"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "error", Error: "something broke"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "error", events[0]["event"])
	var data map[string]string
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "something broke", data["error"])
}

func TestAIChatStream_ErrorEventWithReason(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-error-reason"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "error", Error: "timeout", Reason: "timeout"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	var data map[string]string
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "timeout", data["error"])
	assert.Equal(t, "timeout", data["reason"])
}

func TestAIChatStream_WarningEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-warning"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{Type: "warning", Content: "slow response", Reason: "timeout"}
		ch <- ai.StreamEvent{Type: "content", Content: "actual content"}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Len(t, events, 3)
	assert.Equal(t, "warning", events[0]["event"])
	var warnData map[string]string
	json.Unmarshal([]byte(events[0]["data"]), &warnData)
	assert.Equal(t, "slow response", warnData["text"])
	assert.Equal(t, "timeout", warnData["reason"])
	assert.Equal(t, "content", events[1]["event"])
	assert.Equal(t, "done", events[2]["event"])
}

func TestAIChatStream_QueueConsumeEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-queue-consume"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{
			Type:       "queue_consume",
			QueueEvent: &ai.QueueEventData{Text: "hello", FilePaths: []string{"/test.go"}},
		}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "queue_consume", events[0]["event"])
	var data map[string]any
	json.Unmarshal([]byte(events[0]["data"]), &data)
	assert.Equal(t, "hello", data["text"])
	filePaths := data["filePaths"].([]any)
	assert.Equal(t, "/test.go", filePaths[0])
}

func TestAIChatStream_QueueUpdateEvent(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-queue-update"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	go func() {
		ch <- ai.StreamEvent{
			Type:       "queue_update",
			QueueEvent: &ai.QueueEventData{},
		}
		ch <- ai.StreamEvent{Type: "done"}
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Equal(t, "queue_update", events[0]["event"])
}

func TestAIChatStream_ChannelClosed(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-closed"
	ch := setupStreamSession(sessionID)
	service.SetSessionRunning(sessionID, true)
	defer service.SetSessionRunning(sessionID, false)

	go func() {
		close(ch)
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	w := callHandler(AIChatStream, req)

	events := parseSSEEvents(w.Body.String())
	assert.Len(t, events, 1)
	assert.Equal(t, "done", events[0]["event"])
}

func TestAIChatStream_ClientDisconnect(t *testing.T) {
	env, teardown := setupTestEnv(t)
	defer teardown()

	sessionID := "stream-disconnect"
	ch := setupStreamSession(sessionID)
	defer cleanupStreamSession(sessionID)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	req := newRequest(t, http.MethodGet, "/api/ai/chat/stream?session_id="+sessionID, nil)
	req = withProjectCookie(req, env.ProjectDir)
	req = req.WithContext(ctx)

	w := httptest.NewRecorder()
	AIChatStream(w, req)

	assert.True(t, service.IsSessionRunning(sessionID))
	ch <- ai.StreamEvent{Type: "done"}
}
