# TTS Summarization Backend Abstraction Design

## Summary

将 TTS 内容总结从 SpeechProvider 中解耦为独立的 Summarizer 服务，支持通过配置选择使用 `mmx` 或现有 AI 后端（Claude、Codebuddy、Gemini、OpenCode、Codex）做总结，两者为并列关系。

## Motivation

不同 AI 后端总结质量不同，用户希望灵活选择最合适的总结后端。当前总结逻辑硬编码在三个 SpeechProvider 中，全部使用 `mmx text chat`，无法切换。

## Architecture

### Current

```
SpeechProvider.Summarize()  ->  mmx text chat  (hard-coded in all 3 providers)
SpeechProvider.Synthesize() ->  engine-specific implementation
```

### New

```
Summarizer.Summarize()     ->  mmx / claude / gemini / ...  (independent selection)
SpeechProvider.Synthesize() ->  engine-specific implementation (unchanged)
```

## Components

### 1. Summarizer Interface (`internal/speech/summarizer.go`)

New file containing:

```go
type Summarizer interface {
    Summarize(ctx context.Context, text string) (string, error)
}
```

Shared logic extracted from existing providers:
- Text < 300 chars: return as-is after `StripMarkdown()`
- Text > 10k runes: truncate to last 10k runes
- `StripMarkdown()` utility moves here
- `summarize_prompt.txt` loading logic moves here

### 2. MMXSummarizer (`internal/speech/summarizer.go`)

Extracted from existing provider `Summarize()` methods. Calls `mmx text chat` with the summarize prompt. Behavior identical to current implementation.

### 3. AIBackendSummarizer (`internal/speech/summarizer.go`)

Uses existing `AIBackend.ExecuteStream()` for single-turn summarization:

```go
type AIBackendSummarizer struct {
    backend ai.AIBackend
    prompt  string
}
```

**Workflow:**
1. Construct `ChatRequest`:
   - `Prompt` = summarize prompt + text to summarize
   - `SessionID` = empty (single-turn, no session reuse)
   - `SystemPrompt` = empty
   - `Model` = empty (use backend default)
   - `Command` = empty (use backend default command)
   - `Resume` = false
2. Call `backend.ExecuteStream(ctx, req)` to get event channel
3. Collect all `type: "content"` events, concatenate into full text
4. Return on `type: "done"`, error on `type: "error"`
5. Timeout: 60s (existing context timeout in TTS handler)

**Details:**
- No session persistence; summarization is ephemeral
- tool_use / thinking events are ignored; only content is collected
- Text truncation (<300 skip, >10k truncate) handled in Summarizer layer

### 4. SpeechProvider Interface Simplification (`internal/speech/interface.go`)

```go
// Before
type SpeechProvider interface {
    Summarize(ctx context.Context, text string) (string, error)
    Synthesize(ctx context.Context, text string, outputPath string) error
}

// After
type SpeechProvider interface {
    Synthesize(ctx context.Context, text string, outputPath string) error
}
```

### 5. TTS Provider Changes

- `minimax.go` — Remove `Summarize()` method and related fields (`SummarizeModel`, `SummarizePrompt`)
- `edge_tts.go` — Remove `Summarize()` method
- `piper.go` — Remove `Summarize()` method

### 6. Configuration (`internal/model/config.go`)

New field in `Config.TTS`:

```go
SummarizeBackend string // "mmx" (default) / "claude" / "codebuddy" / "gemini" / "opencode" / "codex"
```

Example `config.yaml`:
```yaml
tts:
  engine: minimax          # unchanged: minimax / edge / piper
  summarize_backend: mmx   # new: mmx / claude / codebuddy / gemini / opencode / codex
```

### 7. Initialization (`cmd/server/main.go`)

New initialization order:
1. Read `cfg.TTS.SummarizeBackend` -> create Summarizer
   - `"mmx"` or empty -> `MMXSummarizer` (default, behavior identical to current)
   - Other values -> `AIBackendSummarizer` via `ai.NewBackend()`
2. Read `cfg.TTS.Engine` -> create SpeechProvider (no longer contains Summarize)
3. Call `handler.SetSummarizer()` and `handler.SetSpeechProvider()` separately

### 8. Handler Changes (`internal/handler/tts.go`)

1. New global variable `summarizer speech.Summarizer`, injectable via `SetSummarizer()`
2. `TTSGenerate` handler: replace `speechProvider.Summarize()` with `summarizer.Summarize()`
3. SSE event format unchanged: `summarizing` / `synthesizing` phases
4. Error handling unchanged: summarize failure -> `SummarizeFailed: true`, TTS pipeline stops

### 9. Frontend: No Changes

TTS SSE event format and interaction flow are completely unchanged. Frontend is unaware of summarizer backend selection.

## Error Handling

- Summarization failure (any backend) -> TTS pipeline stops, frontend shows error
- No fallback mechanism between backends; they are parallel options
- If user wants fallback behavior, they change `summarize_backend` in config

## Shared Logic Relocation

| Logic | Current Location | New Location |
|-------|-----------------|--------------|
| `StripMarkdown()` | `interface.go` | `summarizer.go` |
| `summarize_prompt.txt` loading | each provider | `summarizer.go` |
| Text truncation (<300 skip, >10k truncate) | each provider's `Summarize()` | `summarizer.go` base logic |
| Default summarize prompt | `minimax.go` inline | `summarizer.go` |

## File Changes Summary

| File | Change |
|------|--------|
| `internal/speech/summarizer.go` | **NEW** — Summarizer interface, MMXSummarizer, AIBackendSummarizer, shared logic |
| `internal/speech/interface.go` | Remove `Summarize()` from interface, move `StripMarkdown()` to summarizer.go |
| `internal/speech/minimax.go` | Remove `Summarize()`, `SummarizeModel`, `SummarizePrompt` fields |
| `internal/speech/edge_tts.go` | Remove `Summarize()` |
| `internal/speech/piper.go` | Remove `Summarize()` |
| `internal/handler/tts.go` | Add `summarizer` var + `SetSummarizer()`, replace `Summarize()` call |
| `internal/model/config.go` | Add `SummarizeBackend` field to TTS config |
| `cmd/server/main.go` | Create Summarizer based on config, inject separately |
| `config.example.yaml` | Add `summarize_backend` field with comment |
