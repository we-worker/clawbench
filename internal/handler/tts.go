package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"clawbench/internal/model"
	"clawbench/internal/speech"
)

const (
	// ttsMaxBodyBytes limits the request body size for TTS endpoint (1MB).
	ttsMaxBodyBytes = 1 << 20

	// ttsSummarizeTimeout is the timeout for the summarization step.
	ttsSummarizeTimeout = 60 * time.Second

	// ttsSynthesizeTimeout is the timeout for the TTS synthesis step.
	ttsSynthesizeTimeout = 120 * time.Second
)

// speechProvider is the global speech provider instance.
var speechProvider speech.SpeechProvider = speech.NewMiniMaxProvider()

// SetSpeechProvider replaces the global speech provider.
// Must be called before the HTTP server starts; not goroutine-safe.
func SetSpeechProvider(p speech.SpeechProvider) {
	speechProvider = p
}

// ttsGenerateRequest is the request body for POST /api/tts/generate.
type ttsGenerateRequest struct {
	Text string `json:"text"`
}

// ttsSSEEvent is an SSE event sent during TTS generation.
type ttsSSEEvent struct {
	Type            string `json:"type"`            // "phase" or "result"
	Phase           string `json:"phase,omitempty"` // "summarizing", "synthesizing"
	AudioPath       string `json:"audioPath,omitempty"`
	Summary         string `json:"summary,omitempty"`
	SummarizeFailed bool   `json:"summarizeFailed,omitempty"`
	SynthesizeFailed bool  `json:"synthesizeFailed,omitempty"`
	SynthesizeError string `json:"synthesizeError,omitempty"`
}

// ttsWriteSSE writes a single SSE event and flushes.
func ttsWriteSSE(w http.ResponseWriter, event ttsSSEEvent) {
	data, _ := json.Marshal(event)
	fmt.Fprintf(w, "data: %s\n\n", data)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

// TTSGenerate handles POST /api/tts/generate.
// It streams SSE events to report progress: summarizing → synthesizing → result.
func TTSGenerate(w http.ResponseWriter, r *http.Request) {
	projectPath, ok := requireProject(w, r)
	if !ok {
		return
	}

	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	// Limit request body size
	r.Body = http.MaxBytesReader(w, r.Body, int64(ttsMaxBodyBytes))

	var req ttsGenerateRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.Text == "" {
		model.WriteErrorf(w, http.StatusBadRequest, "text is required")
		return
	}

	if speech.MaxTextRunes > 0 && len([]rune(req.Text)) > speech.MaxTextRunes {
		model.WriteErrorf(w, http.StatusBadRequest, fmt.Sprintf("文本过长，最多支持%d字符", speech.MaxTextRunes))
		return
	}

	// Compute cache key from text content
	hash := sha256.Sum256([]byte(req.Text))
	cacheKey := hex.EncodeToString(hash[:])[:speech.CacheKeyHexLen]
	relAudioPath := filepath.Join(".clawbench", "generated", "tts", cacheKey+".mp3")

	// Validate the output path (defense-in-depth)
	absAudioPath, ok := validateAndResolvePath(w, projectPath, relAudioPath)
	if !ok {
		return
	}

	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// Check cache: if audio file already exists, return immediately
	if info, err := os.Stat(absAudioPath); err == nil && info.Size() > 0 {
		slog.Info("tts cache hit",
			slog.String("cache_key", cacheKey),
			slog.String("path", relAudioPath),
		)
		summaryPath := absAudioPath + ".summary.txt"
		cachedSummary, _ := os.ReadFile(summaryPath)
		ttsWriteSSE(w, ttsSSEEvent{
			Type:       "result",
			AudioPath:  relAudioPath,
			Summary:    string(cachedSummary),
		})
		return
	}

	// Phase 1: Summarize
	ttsWriteSSE(w, ttsSSEEvent{Type: "phase", Phase: "summarizing"})

	summarizeCtx, summarizeCancel := context.WithTimeout(r.Context(), ttsSummarizeTimeout)
	defer summarizeCancel()

	summary, err := speechProvider.Summarize(summarizeCtx, req.Text)
	summarizeFailed := false
	if err != nil {
		slog.Warn("tts summarize failed, using original text",
			slog.String("error", err.Error()),
		)
		summary = req.Text
		summarizeFailed = true
	}

	// Strip any markdown from the summary before synthesis and display
	summary = speech.StripMarkdown(summary)

	slog.Info("tts summarize completed",
		slog.String("cache_key", cacheKey),
		slog.Int("original_len", len([]rune(req.Text))),
		slog.Int("summary_len", len([]rune(summary))),
	)

	// Cache the summary alongside the audio for future cache hits
	summaryPath := absAudioPath + ".summary.txt"
	if err := os.MkdirAll(filepath.Dir(summaryPath), 0755); err == nil {
		if writeErr := os.WriteFile(summaryPath, []byte(summary), 0644); writeErr != nil {
			slog.Warn("tts failed to cache summary",
				slog.String("error", writeErr.Error()),
			)
		}
	}

	// Phase 2: Synthesize
	ttsWriteSSE(w, ttsSSEEvent{Type: "phase", Phase: "synthesizing"})

	synthesizeCtx, synthesizeCancel := context.WithTimeout(r.Context(), ttsSynthesizeTimeout)
	defer synthesizeCancel()

	if err := speechProvider.Synthesize(synthesizeCtx, summary, absAudioPath); err != nil {
		slog.Error("tts synthesize failed",
			slog.String("error", err.Error()),
			slog.String("cache_key", cacheKey),
		)
		ttsWriteSSE(w, ttsSSEEvent{
			Type:             "result",
			SynthesizeFailed: true,
			SynthesizeError:  "语音合成失败，请稍后重试",
			Summary:          summary,
			SummarizeFailed:  summarizeFailed,
		})
		return
	}

	slog.Info("tts generate completed",
		slog.String("cache_key", cacheKey),
		slog.String("path", relAudioPath),
	)

	ttsWriteSSE(w, ttsSSEEvent{
		Type:            "result",
		AudioPath:       relAudioPath,
		Summary:         summary,
		SummarizeFailed: summarizeFailed,
	})
}
