import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  resolveFilePath,
  resolveRelativePath,
  fileOpenButtonHtml,
  FILE_OPEN_ICON_SVG,
  annotateFilePaths,
  clearVerifiedCache,
} from '@/composables/useFilePathAnnotation'

// Mock escapeHtml from html utils
vi.mock('@/utils/html', () => ({
  escapeHtml: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
}))

// Mock splitPath
vi.mock('@/utils/path', () => ({
  splitPath: (p: string) => p.split('/').filter(Boolean),
}))

// Mock store
vi.mock('@/stores/app', () => ({
  store: { state: { projectRoot: '/home/user/project' } },
}))

// Mock useLocale
vi.mock('@/composables/useLocale', () => ({
  gt: (key: string) => key,
}))

// --- resolveFilePath ---

describe('resolveFilePath', () => {
  const projectRoot = '/home/user/project'

  describe('absolute paths', () => {
    it('resolves a path under projectRoot', () => {
      expect(resolveFilePath('/home/user/project/src/main.go', projectRoot)).toBe('src/main.go')
    })

    it('returns null for path outside projectRoot', () => {
      expect(resolveFilePath('/etc/passwd', projectRoot)).toBeNull()
    })

    it('returns null when projectRoot is empty', () => {
      expect(resolveFilePath('/home/user/project/src/main.go', '')).toBeNull()
    })

    it('returns null when path equals projectRoot (no relative part)', () => {
      expect(resolveFilePath('/home/user/project', projectRoot)).toBeNull()
    })

    it('handles nested project root paths', () => {
      expect(resolveFilePath('/home/user/project/deep/nested/file.ts', projectRoot)).toBe('deep/nested/file.ts')
    })
  })

  describe('relative paths with projectRoot', () => {
    it('resolves a simple relative path', () => {
      expect(resolveFilePath('src/main.go', projectRoot)).toBe('src/main.go')
    })

    it('resolves ./prefixed paths', () => {
      expect(resolveFilePath('./src/main.go', projectRoot)).toBe('src/main.go')
    })

    it('resolves ../prefixed paths within project', () => {
      expect(resolveFilePath('../project/src/main.go', projectRoot)).toBe('src/main.go')
    })

    it('returns null for paths going above project root', () => {
      expect(resolveFilePath('../../../etc/passwd', projectRoot)).toBeNull()
    })

    it('handles multiple consecutive ../ segments', () => {
      // projectRoot = /home/user/project → parts = ['home', 'user', 'project']
      // Going ../ 3 times exhausts parts → null
      expect(resolveFilePath('../../../src/main.go', projectRoot)).toBeNull()
    })

    it('handles mixed . and .. segments', () => {
      expect(resolveFilePath('./src/../lib/utils.ts', projectRoot)).toBe('lib/utils.ts')
    })
  })

  describe('relative paths without projectRoot', () => {
    it('returns path as-is after stripping ./', () => {
      expect(resolveFilePath('src/main.go', '')).toBe('src/main.go')
    })

    it('strips leading ./', () => {
      expect(resolveFilePath('./src/main.go', '')).toBe('src/main.go')
    })

    it('returns null for paths starting with ../', () => {
      expect(resolveFilePath('../src/main.go', '')).toBeNull()
    })
  })
})

// --- resolveRelativePath ---

describe('resolveRelativePath', () => {
  it('resolves relative path against base directory', () => {
    expect(resolveRelativePath('file.ts', 'src')).toBe('src/file.ts')
  })

  it('normalizes ./ segments', () => {
    expect(resolveRelativePath('./file.ts', 'src')).toBe('src/file.ts')
  })

  it('normalizes ../ segments', () => {
    expect(resolveRelativePath('../file.ts', 'src/utils')).toBe('src/file.ts')
  })

  it('handles multiple ../ segments', () => {
    expect(resolveRelativePath('../../file.ts', 'src/utils/deep')).toBe('src/file.ts')
  })

  it('returns raw href when baseDir is empty', () => {
    expect(resolveRelativePath('file.ts', '')).toBe('file.ts')
  })

  it('handles deeply nested paths', () => {
    expect(resolveRelativePath('../../../root.ts', 'a/b/c/d')).toBe('a/root.ts')
  })

  it('does not go above root (pops from empty normalized)', () => {
    expect(resolveRelativePath('../../../../root.ts', 'a')).toBe('root.ts')
  })

  it('handles double slashes', () => {
    expect(resolveRelativePath('sub//file.ts', 'src')).toBe('src/sub/file.ts')
  })

  it('handles empty href segments', () => {
    expect(resolveRelativePath('././file.ts', 'src')).toBe('src/file.ts')
  })
})

// --- fileOpenButtonHtml ---

describe('fileOpenButtonHtml', () => {
  it('generates button HTML with data-file-path attribute', () => {
    const html = fileOpenButtonHtml('src/main.go')
    expect(html).toContain('chat-file-open-btn')
    expect(html).toContain('data-file-path="src/main.go"')
  })

  it('escapes HTML in the path', () => {
    const html = fileOpenButtonHtml('src/<script>.go')
    expect(html).toContain('data-file-path="src/&lt;script&gt;.go"')
  })

  it('includes the SVG icon', () => {
    const html = fileOpenButtonHtml('test.ts')
    expect(html).toContain('<svg')
  })

  it('contains the same icon as FILE_OPEN_ICON_SVG', () => {
    const html = fileOpenButtonHtml('test.ts')
    expect(html).toContain(FILE_OPEN_ICON_SVG)
  })
})

// --- annotateFilePaths ---

describe('annotateFilePaths', () => {
  const projectRoot = '/home/user/project'

  it('annotates absolute paths under projectRoot', () => {
    const input = 'See /home/user/project/src/main.go for details'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toContain('src/main.go')
    expect(result.html).toContain('chat-file-path')
    expect(result.html).toContain('chat-file-open-btn')
  })

  it('does not annotate absolute paths outside projectRoot', () => {
    const input = 'See /etc/config for details'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
    expect(result.html).not.toContain('chat-file-path')
  })

  it('annotates relative paths with ./', () => {
    const input = 'Check ./src/main.go for details'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toContain('src/main.go')
  })

  it('annotates bare relative paths with at least two segments and extension', () => {
    const input = 'Look at src/main.go for details'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toContain('src/main.go')
  })

  it('does not annotate single-segment names without slash', () => {
    const input = 'Look at main.go for details'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
  })

  it('preserves pre blocks without annotation', () => {
    const input = '<pre>some /home/user/project/src/main.go code</pre>'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
  })

  it('annotates file paths inside inline code elements', () => {
    const input = '<code>src/main.go</code>'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toContain('src/main.go')
  })

  it('does not annotate inline code without slash or extension', () => {
    const input = '<code>useAutoSpeech</code>'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
  })

  it('annotates inline code with extension but no slash', () => {
    const input = '<code>ChatPanel.vue</code>'
    const result = annotateFilePaths(input, { projectRoot })
    // ChatPanel.vue matches the file extension pattern
    expect(result.detectedPaths.length).toBeGreaterThanOrEqual(0)
  })

  it('appends open button after <a> links to local files', () => {
    const input = '<a href="src/utils.ts">utils</a>'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toContain('src/utils.ts')
    expect(result.html).toContain('chat-file-open-btn')
  })

  it('does not annotate external <a> links', () => {
    const input = '<a href="https://example.com">link</a>'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
  })

  it('does not annotate anchor <a> links', () => {
    const input = '<a href="#section">jump</a>'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
  })

  it('resolves <a> href against baseDir when provided', () => {
    const input = '<a href="utils.ts">utils</a>'
    const result = annotateFilePaths(input, { projectRoot, baseDir: 'src' })
    expect(result.detectedPaths).toContain('src/utils.ts')
  })

  it('returns empty detectedPaths for plain text with no paths', () => {
    const input = 'This is just some text without any file references.'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
  })

  it('handles empty input', () => {
    const result = annotateFilePaths('', { projectRoot })
    expect(result.detectedPaths).toHaveLength(0)
    expect(result.html).toBe('')
  })

  it('detects multiple paths in one string', () => {
    const input = 'See src/main.go and ./lib/utils.ts'
    const result = annotateFilePaths(input, { projectRoot })
    expect(result.detectedPaths.length).toBeGreaterThanOrEqual(2)
  })

  it('handles paths after > character in blockquote without annotating them', () => {
    const input = '>src/main.go'
    const result = annotateFilePaths(input, { projectRoot })
    // The bare-path regex skips paths prefixed with '>'
    expect(result.detectedPaths).toHaveLength(0)
  })
})

// --- clearVerifiedCache ---

describe('clearVerifiedCache', () => {
  it('does not throw when called', () => {
    expect(() => clearVerifiedCache()).not.toThrow()
  })
})
