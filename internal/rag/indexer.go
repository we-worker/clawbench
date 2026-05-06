package rag

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"clawbench/internal/model"
	"clawbench/internal/service"
)

// Indexer polls for unindexed chat messages and generates embeddings.
type Indexer struct {
	store     *Store
	embedder  *EmbeddingClient
	cfg       model.RAGConfig
	stopCh    chan struct{}
	doneCh    chan struct{}
	mu        sync.Mutex
	running   bool
	modelWarn bool // Whether we've warned about missing model
}

// NewIndexer creates a new RAG indexer.
func NewIndexer(store *Store, embedder *EmbeddingClient, cfg model.RAGConfig) *Indexer {
	return &Indexer{
		store:    store,
		embedder: embedder,
		cfg:      cfg,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
}

// Start begins the indexer loop in a goroutine.
func (idx *Indexer) Start() {
	idx.mu.Lock()
	if idx.running {
		idx.mu.Unlock()
		return
	}
	idx.running = true
	idx.mu.Unlock()

	go idx.run()
	slog.Info("rag indexer started",
		slog.String("poll_interval", idx.cfg.PollInterval),
		slog.Int("batch_size", idx.cfg.BatchSize),
		slog.Int("chunk_size", idx.cfg.ChunkSize),
	)
}

// Stop signals the indexer to stop and waits for it to finish.
func (idx *Indexer) Stop() {
	idx.mu.Lock()
	if !idx.running {
		idx.mu.Unlock()
		return
	}
	idx.mu.Unlock()

	close(idx.stopCh)
	<-idx.doneCh

	idx.mu.Lock()
	idx.running = false
	idx.mu.Unlock()

	slog.Info("rag indexer stopped")
}

// run is the main indexer loop.
func (idx *Indexer) run() {
	defer close(idx.doneCh)

	pollInterval, err := time.ParseDuration(idx.cfg.PollInterval)
	if err != nil {
		slog.Error("invalid rag poll_interval, using 10s", slog.String("value", idx.cfg.PollInterval), slog.String("err", err.Error()))
		pollInterval = 10 * time.Second
	}

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	// Run first indexing immediately
	idx.indexBatch()

	for {
		select {
		case <-idx.stopCh:
			return
		case <-ticker.C:
			idx.indexBatch()
		}
	}
}

// indexBatch processes one batch of unindexed messages.
func (idx *Indexer) indexBatch() {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// Check Ollama health
	reachable, modelAvailable, err := idx.embedder.IsHealthy(ctx)
	if err != nil {
		slog.Debug("rag: ollama health check error", slog.String("err", err.Error()))
		return
	}
	if !reachable {
		slog.Debug("rag: ollama not reachable, skipping batch")
		return
	}
	if !modelAvailable {
		if !idx.modelWarn {
			slog.Warn("rag: ollama model not available, skipping batch",
				slog.String("model", idx.cfg.OllamaModel),
			)
			idx.modelWarn = true
		}
		return
	}
	idx.modelWarn = false // Reset warning flag

	// Fetch unindexed messages from SQLite
	messages, err := service.GetUnindexedMessages(idx.cfg.BatchSize)
	if err != nil {
		slog.Error("rag: failed to fetch unindexed messages", slog.String("err", err.Error()))
		return
	}
	if len(messages) == 0 {
		return
	}

	slog.Info("rag: indexing batch", slog.Int("messages", len(messages)))

	for _, msg := range messages {
		if err := idx.indexMessage(ctx, msg); err != nil {
			slog.Error("rag: failed to index message",
				slog.Int64("message_id", msg.ID),
				slog.String("err", err.Error()),
			)
			// Continue with next message — don't let one failure stop the batch
			continue
		}

		// Mark message as indexed in SQLite
		if err := service.MarkMessageIndexed(msg.ID); err != nil {
			slog.Error("rag: failed to mark message indexed",
				slog.Int64("message_id", msg.ID),
				slog.String("err", err.Error()),
			)
		}
	}
}

// indexMessage processes a single message: extract text, chunk, embed, store.
func (idx *Indexer) indexMessage(ctx context.Context, msg service.UnindexedMessage) error {
	// Extract text content
	text := ExtractTextFromContent(msg.Content, msg.Role)
	if text == "" {
		// No text content (e.g., only tool_use blocks) — mark as indexed to skip
		return nil
	}

	// Chunk the text
	textChunks := ChunkText(text, idx.cfg.ChunkSize, idx.cfg.ChunkOverlap)
	if len(textChunks) == 0 {
		return nil
	}

	// Limit chunks per message to prevent runaway
	maxChunks := 50
	if len(textChunks) > maxChunks {
		slog.Warn("rag: message produced too many chunks, truncating",
			slog.Int64("message_id", msg.ID),
			slog.Int("original", len(textChunks)),
			slog.Int("truncated", maxChunks),
		)
		textChunks = textChunks[:maxChunks]
	}

	// Generate embeddings for all chunks
	texts := make([]string, len(textChunks))
	for i, tc := range textChunks {
		texts[i] = tc.Text
	}

	embeddings, err := idx.embedder.EmbedBatch(ctx, texts)
	if err != nil {
		return fmt.Errorf("embed batch: %w", err)
	}

	// Build Chunk objects for storage
	chunks := make([]Chunk, len(textChunks))
	for i, tc := range textChunks {
		chunks[i] = Chunk{
			SessionID:   msg.SessionID,
			MessageID:   msg.ID,
			ChunkText:   tc.Text,
			ChunkIndex:  tc.Index,
			TokenCount:  tc.TokenCount,
			Embedding:   embeddings[i],
			ProjectPath: msg.ProjectPath,
			Backend:     msg.Backend,
			Role:        msg.Role,
			CreatedAt:   msg.CreatedAt,
		}
	}

	// Store in DuckDB
	return idx.store.InsertChunks(chunks)
}
