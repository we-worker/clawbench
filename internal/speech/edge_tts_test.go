package speech

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewEdgeTTSProvider_Defaults(t *testing.T) {
	p := NewEdgeTTSProvider()
	assert.Equal(t, edgeDefaultVoice, p.Voice)
	assert.Equal(t, "+0%", p.Rate)
}

func TestEdgeTTSProvider_Synthesize_CancelledContext(t *testing.T) {
	p := NewEdgeTTSProvider()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	outputPath := filepath.Join(t.TempDir(), "output.mp3")
	err := p.Synthesize(ctx, "hello", outputPath, "zh")
	assert.Error(t, err)
}

func TestEdgeTTSProvider_Synthesize_MissingBinary(t *testing.T) {
	p := NewEdgeTTSProvider()

	outputPath := filepath.Join(t.TempDir(), "output.mp3")
	err := p.Synthesize(context.Background(), "hello", outputPath, "zh")
	assert.Error(t, err)
}

func TestEdgeTTSProvider_Synthesize_CreatesDirectory(t *testing.T) {
	p := NewEdgeTTSProvider()

	tmpDir := t.TempDir()
	nestedDir := filepath.Join(tmpDir, "nested", "deep")
	outputPath := filepath.Join(nestedDir, "output.mp3")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := p.Synthesize(ctx, "hello", outputPath, "zh")

	require.Error(t, err)
	_, statErr := os.Stat(nestedDir)
	assert.NoError(t, statErr, "output directory should be created even if synthesis fails")
}
