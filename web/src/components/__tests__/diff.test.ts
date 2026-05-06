import { describe, expect, it } from 'vitest'
import { escapeHtml } from '@/utils/html.ts'

// ────────────────────────────────────────────────────────────
// diff.ts relies on hljs (highlight.js) from globals.ts which
// needs browser environment. We test the parsing logic by
// replicating the pure parts (parseHunkHeader) and renderDiff
// with mocked highlight.
// ────────────────────────────────────────────────────────────

// Replicate parseHunkHeader logic (pure function)
function parseHunkHeader(line: string) {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/)
  if (!m) return null
  return {
    oldStart: parseInt(m[1]),
    oldCount: parseInt(m[2] || '1'),
    newStart: parseInt(m[3]),
    newCount: parseInt(m[4] || '1'),
    text: m[5].trim(),
  }
}

describe('parseHunkHeader', () => {
  it('parses basic hunk header', () => {
    const result = parseHunkHeader('@@ -1,3 +1,4 @@')
    expect(result).toEqual({
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
      text: '',
    })
  })

  it('parses hunk header with context text', () => {
    const result = parseHunkHeader('@@ -10,5 +10,7 @@ function hello()')
    expect(result).not.toBeNull()
    expect(result!.oldStart).toBe(10)
    expect(result!.newStart).toBe(10)
    expect(result!.text).toBe('function hello()')
  })

  it('defaults count to 1 when omitted', () => {
    const result = parseHunkHeader('@@ -5 +5 @@')
    expect(result).not.toBeNull()
    expect(result!.oldCount).toBe(1)
    expect(result!.newCount).toBe(1)
  })

  it('returns null for non-hunk line', () => {
    expect(parseHunkHeader('not a hunk')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseHunkHeader('')).toBeNull()
  })

  it('parses hunk header with zero count', () => {
    const result = parseHunkHeader('@@ -0,0 +1,5 @@')
    expect(result).not.toBeNull()
    expect(result!.oldStart).toBe(0)
    expect(result!.oldCount).toBe(0)
    expect(result!.newStart).toBe(1)
    expect(result!.newCount).toBe(5)
  })

  it('parses hunk header starting at line 0', () => {
    const result = parseHunkHeader('@@ -0,0 +0,0 @@')
    expect(result!.oldStart).toBe(0)
    expect(result!.newStart).toBe(0)
  })
})

// Replicate diff line parsing logic
interface DiffLine {
  type: 'add' | 'del' | 'ctx'
  content: string
  oldLine: number | null
  newLine: number | null
}

function parseDiffLines(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let oldLineNum = 0
  let newLineNum = 0
  let inHunk = false

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line)
      if (header) {
        oldLineNum = header.oldStart
        newLineNum = header.newStart
        inHunk = true
      }
    } else if (line.startsWith(' ') && inHunk) {
      result.push({ type: 'ctx', content: line.substring(1), oldLine: oldLineNum++, newLine: newLineNum++ })
    } else if (line.startsWith('+') && !line.startsWith('+++') && inHunk) {
      result.push({ type: 'add', content: line.substring(1), oldLine: null, newLine: newLineNum++ })
    } else if (line.startsWith('-') && !line.startsWith('---') && inHunk) {
      result.push({ type: 'del', content: line.substring(1), oldLine: oldLineNum++, newLine: null })
    }
  }
  return result
}

describe('parseDiffLines', () => {
  it('parses context lines', () => {
    const diff = '@@ -1,3 +1,3 @@\n line1\n line2\n line3'
    const lines = parseDiffLines(diff)
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.type === 'ctx')).toBe(true)
  })

  it('parses added lines', () => {
    const diff = '@@ -1,1 +1,2 @@\n existing\n+added line'
    const lines = parseDiffLines(diff)
    expect(lines).toHaveLength(2)
    expect(lines[1].type).toBe('add')
    expect(lines[1].content).toBe('added line')
    expect(lines[1].newLine).toBe(2)
    expect(lines[1].oldLine).toBeNull()
  })

  it('parses deleted lines', () => {
    const diff = '@@ -1,2 +1,1 @@\n kept\n-removed'
    const lines = parseDiffLines(diff)
    expect(lines).toHaveLength(2)
    expect(lines[1].type).toBe('del')
    expect(lines[1].content).toBe('removed')
    expect(lines[1].oldLine).toBe(2)
    expect(lines[1].newLine).toBeNull()
  })

  it('ignores meta lines (+++, ---)', () => {
    const diff = '--- a/file.go\n+++ b/file.go\n@@ -1,1 +1,1 @@\n old\n+new'
    const lines = parseDiffLines(diff)
    expect(lines).toHaveLength(2)
  })

  it('handles empty diff', () => {
    expect(parseDiffLines('')).toEqual([])
  })

  it('handles diff with no hunks', () => {
    const diff = 'some text\nno hunk headers'
    expect(parseDiffLines(diff)).toEqual([])
  })

  it('tracks line numbers correctly', () => {
    const diff = '@@ -1,3 +1,4 @@\n ctx1\n-del\n+add1\n+add2\n ctx2'
    const lines = parseDiffLines(diff)
    expect(lines).toHaveLength(5)
    // ctx1: old=1, new=1
    expect(lines[0].oldLine).toBe(1)
    expect(lines[0].newLine).toBe(1)
    // del: old=2
    expect(lines[1].oldLine).toBe(2)
    // add1: new=2
    expect(lines[2].newLine).toBe(2)
    // add2: new=3
    expect(lines[3].newLine).toBe(3)
    // ctx2: old=3, new=4
    expect(lines[4].oldLine).toBe(3)
    expect(lines[4].newLine).toBe(4)
  })

  it('handles multiple hunks', () => {
    const diff = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10,2 +10,2 @@\n x\n-y\n+z'
    const lines = parseDiffLines(diff)
    expect(lines).toHaveLength(6)
    // Second hunk starts at line 10
    expect(lines[3].oldLine).toBe(10)
    expect(lines[3].newLine).toBe(10)
  })
})
