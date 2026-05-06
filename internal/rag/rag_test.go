package rag

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExtractTextFromContent_UserMessage(t *testing.T) {
	text := ExtractTextFromContent("Hello, how are you?", "user")
	assert.Equal(t, "Hello, how are you?", text)
}

func TestExtractTextFromContent_AssistantTextOnly(t *testing.T) {
	content := `{"blocks":[{"type":"text","text":"Here is the answer."}]}`
	text := ExtractTextFromContent(content, "assistant")
	assert.Equal(t, "Here is the answer.", text)
}

func TestExtractTextFromContent_AssistantMixedBlocks(t *testing.T) {
	content := `{"blocks":[
		{"type":"text","text":"Let me read that file."},
		{"type":"thinking","text":"I should check the config..."},
		{"type":"tool_use","name":"Read","id":"toolu_1","input":{"file_path":"/etc/config"},"done":true},
		{"type":"text","text":"The config shows XYZ."}
	]}`
	text := ExtractTextFromContent(content, "assistant")
	assert.Equal(t, "Let me read that file.\n\nThe config shows XYZ.", text)
}

func TestExtractTextFromContent_AssistantOnlyToolUse(t *testing.T) {
	content := `{"blocks":[
		{"type":"tool_use","name":"Write","id":"toolu_1","input":{"file_path":"/tmp/test","content":"hello"},"done":true}
	]}`
	text := ExtractTextFromContent(content, "assistant")
	assert.Equal(t, "", text)
}

func TestExtractTextFromContent_InvalidJSON(t *testing.T) {
	text := ExtractTextFromContent("not json at all", "assistant")
	assert.Equal(t, "not json at all", text)
}

func TestEstimateTokens_English(t *testing.T) {
	tokens := estimateTokens("Hello world, this is a test.")
	assert.Greater(t, tokens, 0)
	assert.Less(t, tokens, 20) // Rough check
}

func TestEstimateTokens_CJK(t *testing.T) {
	tokens := estimateTokens("这是一个中文测试")
	assert.Greater(t, tokens, 0)
}

func TestEstimateTokens_Mixed(t *testing.T) {
	tokens := estimateTokens("Hello 你好 world 世界")
	assert.Greater(t, tokens, 0)
}

func TestChunkText_ShortText(t *testing.T) {
	chunks := ChunkText("Hello world", 512, 64)
	assert.Len(t, chunks, 1)
	assert.Equal(t, "Hello world", chunks[0].Text)
	assert.Equal(t, 0, chunks[0].Index)
}

func TestChunkText_EmptyText(t *testing.T) {
	chunks := ChunkText("", 512, 64)
	assert.Nil(t, chunks)
}

func TestChunkText_LongText(t *testing.T) {
	// Generate a long text that should be split
	longText := ""
	for i := 0; i < 100; i++ {
		longText += "This is sentence number " + string(rune('0'+i%10)) + " in the test. "
	}
	// Should produce multiple chunks with chunkSize=50
	chunks := ChunkText(longText, 50, 10)
	assert.Greater(t, len(chunks), 1)

	// Verify indices are sequential
	for i, c := range chunks {
		assert.Equal(t, i, c.Index)
	}
}

func TestChunkText_ParagraphBreak(t *testing.T) {
	text := "First paragraph content.\n\nSecond paragraph content.\n\nThird paragraph content."
	chunks := ChunkText(text, 10, 2)
	// Should prefer paragraph breaks
	assert.Greater(t, len(chunks), 0)
}
