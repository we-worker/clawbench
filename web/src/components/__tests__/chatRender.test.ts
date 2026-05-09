import { describe, expect, it, vi, beforeEach } from 'vitest'

// ────────────────────────────────────────────────────────────
// parseAssistantContent logic (extracted from useChatRender for testing)
// The actual function lives inside useChatRender composable.
// We replicate the logic here to test the block parsing and dedup.
// ────────────────────────────────────────────────────────────

function parseAssistantContent(content: string) {
  if (!content) return { blocks: [], metadata: null }
  try {
    const parsed = JSON.parse(content)
    if (parsed.blocks && Array.isArray(parsed.blocks)) {
      const mapped = parsed.blocks.map(b => {
        if (b.type === 'tool_use') {
          if (b.done === undefined || b.done === false) b.done = true
          // Backward compat: old Codex format had output in input.output
          if (!b.output && b.input && b.input.output) {
            b.output = b.input.output
            delete b.input.output
          }
        }
        return b
      })
      const result: any[] = []
      const toolIndex = new Map()
      for (const b of mapped) {
        if (b.type === 'tool_use' && b.id) {
          const prevIdx = toolIndex.get(b.id)
          if (prevIdx !== undefined) {
            const prev = result[prevIdx]
            const prevEmpty = !prev.input || Object.keys(prev.input).length === 0
            const currEmpty = !b.input || Object.keys(b.input).length === 0
            if (currEmpty && !prevEmpty) continue
            if (!currEmpty && prevEmpty) {
              prev.input = b.input
              prev.done = b.done
              prev.name = b.name || prev.name
              if (b.output) prev.output = b.output
              if (b.status) prev.status = b.status
              continue
            }
            if (b.done) prev.done = true
            if (!currEmpty) prev.input = b.input
            if (b.output) prev.output = b.output
            if (b.status) prev.status = b.status
            continue
          }
          toolIndex.set(b.id, result.length)
        }
        result.push(b)
      }
      return {
        blocks: result,
        metadata: parsed.metadata || null,
        cancelled: parsed.cancelled || false
      }
    }
  } catch {}
  return { blocks: [{ type: 'text', text: content }], metadata: null }
}

describe('parseAssistantContent', () => {
  it('returns empty blocks for null content', () => {
    expect(parseAssistantContent(null as any)).toEqual({ blocks: [], metadata: null })
  })

  it('returns empty blocks for undefined content', () => {
    expect(parseAssistantContent(undefined as any)).toEqual({ blocks: [], metadata: null })
  })

  it('returns empty blocks for empty string', () => {
    expect(parseAssistantContent('')).toEqual({ blocks: [], metadata: null })
  })

  it('returns text block for non-JSON content', () => {
    const result = parseAssistantContent('Hello, this is plain text')
    expect(result.blocks).toEqual([{ type: 'text', text: 'Hello, this is plain text' }])
    expect(result.metadata).toBeNull()
  })

  it('parses JSON with blocks array', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/test.go' } },
      ],
      metadata: { tokens: 100 },
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[1].type).toBe('tool_use')
    expect(result.metadata).toEqual({ tokens: 100 })
  })

  it('marks tool_use blocks as done when done is missing', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: '1', input: {} },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].done).toBe(true)
  })

  it('marks tool_use blocks as done when done is false', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: '1', input: {}, done: false },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].done).toBe(true)
  })

  it('preserves done=true on tool_use blocks', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: '1', input: {}, done: true },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].done).toBe(true)
  })

  it('deduplicates tool_use blocks by id - keeps richer input', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: '1', input: {} },
        { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/test.go' } },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].input).toEqual({ file_path: '/test.go' })
  })

  it('deduplicates tool_use blocks - keeps previous when current is empty', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/test.go' } },
        { type: 'tool_use', name: 'Read', id: '1', input: {} },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].input).toEqual({ file_path: '/test.go' })
  })

  it('merges tool_use blocks when both have input', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/old.go' }, done: false },
        { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/new.go' }, done: true },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].input).toEqual({ file_path: '/new.go' })
    expect(result.blocks[0].done).toBe(true)
  })

  it('extracts cancelled flag', () => {
    const content = JSON.stringify({
      blocks: [{ type: 'text', text: 'partial' }],
      cancelled: true,
    })
    const result = parseAssistantContent(content)
    expect(result.cancelled).toBe(true)
  })

  it('defaults cancelled to false', () => {
    const content = JSON.stringify({
      blocks: [{ type: 'text', text: 'done' }],
    })
    const result = parseAssistantContent(content)
    expect(result.cancelled).toBe(false)
  })

  it('defaults metadata to null when not present', () => {
    const content = JSON.stringify({
      blocks: [{ type: 'text', text: 'hello' }],
    })
    const result = parseAssistantContent(content)
    expect(result.metadata).toBeNull()
  })

  it('handles JSON without blocks array as text fallback', () => {
    const content = JSON.stringify({ message: 'not blocks' })
    const result = parseAssistantContent(content)
    // JSON.parse succeeds but no blocks array -> falls back to text
    expect(result.blocks).toEqual([{ type: 'text', text: content }])
  })

  it('handles text blocks interleaved with tool_use blocks', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'text', text: 'Starting...' },
        { type: 'tool_use', name: 'Read', id: '1', input: { file_path: '/a.go' } },
        { type: 'text', text: 'Result:' },
        { type: 'tool_use', name: 'Grep', id: '2', input: { pattern: 'TODO' } },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(4)
  })
})

// ────────────────────────────────────────────────────────────
// Additional pure functions from useChatRender
// ────────────────────────────────────────────────────────────

function hasImagesInContent(content: string) {
  return content && content.includes('![')
}

function formatMessageTime(createdAt: string) {
  const date = new Date(createdAt)
  const now = new Date()
  const diffMs = now - date
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins} min ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours().toString().padStart(2, '0')
  const minute = date.getMinutes().toString().padStart(2, '0')
  return `${month}/${day} ${hour}:${minute}`
}

function formatDetailTime(createdAt: string) {
  const date = new Date(createdAt)
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  const hour = date.getHours().toString().padStart(2, '0')
  const minute = date.getMinutes().toString().padStart(2, '0')
  const second = date.getSeconds().toString().padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function truncate(str: string, len: number) {
  if (!str) return ''
  const runes = [...str]
  return runes.length > len ? runes.slice(0, len).join('') + '...' : str
}

describe('hasImagesInContent', () => {
  it('detects markdown image syntax', () => {
    expect(hasImagesInContent('![alt](url)')).toBe(true)
  })

  it('returns false for text without images', () => {
    expect(hasImagesInContent('plain text')).toBe(false)
  })

  it('returns falsy for empty string', () => {
    expect(hasImagesInContent('')).toBeFalsy()
  })

  it('returns falsy for null', () => {
    expect(hasImagesInContent(null as any)).toBeFalsy()
  })
})

describe('formatDetailTime', () => {
  it('formats ISO date string correctly', () => {
    const result = formatDetailTime('2026-01-15T14:30:45.000Z')
    expect(result).toMatch(/2026/)
    expect(result).toMatch(/01/)
    expect(result).toMatch(/15/)
  })

  it('pads single-digit months and days', () => {
    const result = formatDetailTime('2026-03-05T09:05:03.000Z')
    expect(result).toContain('03')
    expect(result).toContain('05')
  })
})

describe('truncate', () => {
  it('returns empty for null/undefined', () => {
    expect(truncate(null as any, 10)).toBe('')
    expect(truncate(undefined as any, 10)).toBe('')
  })

  it('returns string unchanged when shorter than limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('truncates and adds ellipsis when longer than limit', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
  })

  it('handles exact length without truncation', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('handles emoji/unicode correctly (runes, not bytes)', () => {
    expect(truncate('🎉🎊🎁', 2)).toBe('🎉🎊...')
  })
})

// ────────────────────────────────────────────────────────────
// Tool output/status backward compat and dedup
// ────────────────────────────────────────────────────────────

describe('parseAssistantContent tool output/status', () => {
  it('preserves output and status on tool_use blocks', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'ls' }, done: true, output: 'file1.go\nfile2.go', status: 'success' },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].output).toBe('file1.go\nfile2.go')
    expect(result.blocks[0].status).toBe('success')
  })

  it('migrates old Codex input.output to output field', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'ls', output: 'old-format-output' }, done: true },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].output).toBe('old-format-output')
    expect(result.blocks[0].input.output).toBeUndefined()
  })

  it('does not overwrite existing output with input.output', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Bash', id: 't3', input: { command: 'ls', output: 'legacy' }, done: true, output: 'new-format' },
      ],
    })
    const result = parseAssistantContent(content)
    // When output already exists, input.output migration is skipped
    expect(result.blocks[0].output).toBe('new-format')
  })

  it('preserves error status on tool_use blocks', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Bash', id: 't4', input: { command: 'bad' }, done: true, output: 'command not found', status: 'error' },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].status).toBe('error')
    expect(result.blocks[0].output).toBe('command not found')
  })

  it('merges output and status during dedup - second block has output', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: 't5', input: { file_path: '/a.go' }, done: true },
        { type: 'tool_use', name: 'Read', id: 't5', input: { file_path: '/a.go' }, done: true, output: 'file contents', status: 'success' },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].output).toBe('file contents')
    expect(result.blocks[0].status).toBe('success')
  })

  it('merges output from first block when second is empty', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: 't6', input: { file_path: '/a.go' }, done: true, output: 'result', status: 'success' },
        { type: 'tool_use', name: 'Read', id: 't6', input: {}, done: true },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks).toHaveLength(1)
    // First block has output, second is empty — keep previous
    expect(result.blocks[0].output).toBe('result')
    expect(result.blocks[0].status).toBe('success')
  })

  it('tool_use without output or status is valid (Codebuddy/Claude backends)', () => {
    const content = JSON.stringify({
      blocks: [
        { type: 'tool_use', name: 'Read', id: 't7', input: { file_path: '/a.go' }, done: true },
      ],
    })
    const result = parseAssistantContent(content)
    expect(result.blocks[0].output).toBeUndefined()
    expect(result.blocks[0].status).toBeUndefined()
    expect(result.blocks[0].done).toBe(true)
  })
})
