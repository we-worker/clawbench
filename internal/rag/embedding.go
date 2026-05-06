package rag

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// EmbeddingClient calls the Ollama /api/embeddings endpoint.
type EmbeddingClient struct {
	BaseURL    string
	Model      string
	HTTPClient *http.Client
}

// NewEmbeddingClient creates a new Ollama embedding client.
func NewEmbeddingClient(baseURL, model string) *EmbeddingClient {
	return &EmbeddingClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Model:   model,
		HTTPClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// ollamaEmbedRequest is the request body for POST /api/embeddings.
type ollamaEmbedRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
}

// ollamaEmbedResponse is the response body for POST /api/embeddings.
type ollamaEmbedResponse struct {
	Embedding []float64 `json:"embedding"`
}

// ollamaTagsResponse is the response body for GET /api/tags.
type ollamaTagsResponse struct {
	Models []ollamaModelInfo `json:"models"`
}

type ollamaModelInfo struct {
	Name string `json:"name"`
}

// Embed generates an embedding vector for the given text.
func (c *EmbeddingClient) Embed(ctx context.Context, text string) ([]float64, error) {
	reqBody := ollamaEmbedRequest{
		Model:  c.Model,
		Prompt: text,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal embed request: %w", err)
	}

	url := c.BaseURL + "/api/embeddings"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("create embed request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embed request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama embed API returned status %d: %s", resp.StatusCode, string(body))
	}

	var embedResp ollamaEmbedResponse
	if err := json.NewDecoder(resp.Body).Decode(&embedResp); err != nil {
		return nil, fmt.Errorf("decode embed response: %w", err)
	}

	if len(embedResp.Embedding) == 0 {
		return nil, fmt.Errorf("ollama returned empty embedding for model %s", c.Model)
	}

	return embedResp.Embedding, nil
}

// EmbedBatch generates embeddings for multiple texts.
// Returns embeddings in the same order as input texts.
// If any individual embedding fails, returns error for the whole batch.
func (c *EmbeddingClient) EmbedBatch(ctx context.Context, texts []string) ([][]float64, error) {
	embeddings := make([][]float64, len(texts))
	for i, text := range texts {
		emb, err := c.Embed(ctx, text)
		if err != nil {
			return nil, fmt.Errorf("embed text %d/%d: %w", i+1, len(texts), err)
		}
		embeddings[i] = emb
	}
	return embeddings, nil
}

// IsHealthy checks if Ollama is reachable and the configured model is available.
// Returns (reachable, modelAvailable, error).
func (c *EmbeddingClient) IsHealthy(ctx context.Context) (bool, bool, error) {
	url := c.BaseURL + "/api/tags"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, false, fmt.Errorf("create health request: %w", err)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return false, false, nil // Not reachable, but not an error per se
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, false, fmt.Errorf("ollama tags API returned status %d", resp.StatusCode)
	}

	var tagsResp ollamaTagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tagsResp); err != nil {
		return true, false, fmt.Errorf("decode tags response: %w", err)
	}

	for _, m := range tagsResp.Models {
		if m.Name == c.Model || strings.HasPrefix(m.Name, c.Model+":") {
			return true, true, nil
		}
	}

	slog.Warn("ollama is reachable but model not found",
		slog.String("model", c.Model),
		slog.Int("available_models", len(tagsResp.Models)),
	)
	return true, false, nil
}
