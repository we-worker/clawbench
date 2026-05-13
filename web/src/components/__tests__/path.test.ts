import { describe, expect, it } from 'vitest'
import { baseName, dirName, splitPath, toRelativePath } from '@/utils/path.ts'

describe('splitPath', () => {
  it('splits unix path by /', () => {
    expect(splitPath('/home/user/project')).toEqual(['', 'home', 'user', 'project'])
  })

  it('splits windows path by \\', () => {
    expect(splitPath('C:\\Users\\admin\\file.txt')).toEqual(['C:', 'Users', 'admin', 'file.txt'])
  })

  it('splits mixed separators', () => {
    expect(splitPath('a/b\\c')).toEqual(['a', 'b', 'c'])
  })

  it('handles single segment', () => {
    expect(splitPath('file.txt')).toEqual(['file.txt'])
  })

  it('handles empty string', () => {
    expect(splitPath('')).toEqual([''])
  })

  it('handles root path /', () => {
    expect(splitPath('/')).toEqual(['', ''])
  })

  it('handles consecutive slashes', () => {
    expect(splitPath('a//b')).toEqual(['a', '', 'b'])
  })

  it('handles path with only separators', () => {
    expect(splitPath('/\\')).toEqual(['', '', ''])
  })
})

describe('baseName', () => {
  it('returns filename from unix path', () => {
    expect(baseName('/home/user/file.go')).toBe('file.go')
  })

  it('returns filename from windows path', () => {
    expect(baseName('C:\\Users\\admin\\file.txt')).toBe('file.txt')
  })

  it('returns last segment for directory path without trailing slash', () => {
    expect(baseName('/home/user/project')).toBe('project')
  })

  it('returns segment for single segment', () => {
    expect(baseName('file.txt')).toBe('file.txt')
  })

  it('handles path with trailing slash', () => {
    const result = baseName('/home/user/')
    expect(result).toBe('/home/user/')
  })

  it('handles root path', () => {
    expect(baseName('/')).toBe('/')
  })

  it('handles dot files', () => {
    expect(baseName('.gitignore')).toBe('.gitignore')
  })

  it('handles hidden file in directory', () => {
    expect(baseName('/home/user/.bashrc')).toBe('.bashrc')
  })

  it('handles multiple extensions', () => {
    expect(baseName('/path/to/archive.tar.gz')).toBe('archive.tar.gz')
  })
})

describe('dirName', () => {
  it('returns parent directory from unix path', () => {
    expect(dirName('/home/user/file.go')).toBe('/home/user')
  })

  it('returns parent directory from windows path', () => {
    expect(dirName('C:\\Users\\admin\\file.txt')).toBe('C:\\Users\\admin')
  })

  it('returns drive root for file in drive root', () => {
    expect(dirName('C:\\file.txt')).toBe('C:\\')
  })

  it('returns empty for single segment', () => {
    expect(dirName('file.txt')).toBe('')
  })

  it('handles unix root path', () => {
    expect(dirName('/file.txt')).toBe('')
  })

  it('handles nested paths', () => {
    expect(dirName('/a/b/c/d')).toBe('/a/b/c')
  })

  it('handles windows paths with backslash separator', () => {
    expect(dirName('a\\b\\c')).toBe('a\\b')
  })

  it('handles deeply nested unix path', () => {
    expect(dirName('/a/b/c/d/e/f')).toBe('/a/b/c/d/e')
  })

  it('handles path with only two segments', () => {
    expect(dirName('/file')).toBe('')
  })

  it('handles dot file dirName', () => {
    expect(dirName('/home/user/.bashrc')).toBe('/home/user')
  })

  it('handles path with mixed separators (uses forward slash by default)', () => {
    // Mixed paths use / as join since path includes /
    expect(dirName('a/b\\c')).toBe('a/b')
  })
})

describe('toRelativePath', () => {
  it('converts absolute path to relative path', () => {
    expect(toRelativePath('/home/user/project/src/file.ts', '/home/user/project')).toBe('src/file.ts')
  })

  it('returns original path when base is empty', () => {
    expect(toRelativePath('/home/user/project', '')).toBe('/home/user/project')
  })

  it('returns "/" when path equals base', () => {
    expect(toRelativePath('/home/user/project', '/home/user/project')).toBe('/')
  })

  it('strips leading slash from result', () => {
    expect(toRelativePath('/home/user/project/src', '/home/user/project')).toBe('src')
  })

  it('handles base with trailing slash', () => {
    expect(toRelativePath('/home/user/project/src/file.ts', '/home/user/project/')).toBe('src/file.ts')
  })

  it('handles empty path', () => {
    expect(toRelativePath('', '/home')).toBe('/')
  })

  it('handles both empty', () => {
    // '' slice '' = '', replace = '', || '/' => '' (empty string is falsy but '' || '/' gives '/' wait...)
    // Actually: ''.replace(/^\//, '') = '', '' || '/' = '/' — but let's check actual behavior
    // absPath='', basePath='' => !basePath is false (empty string is falsy, so returns absPath='')
    expect(toRelativePath('', '')).toBe('')
  })

  it('handles path that does not start with base', () => {
    // Function just slices: '/other/path'.slice('/home/user'.length) = 'h'
    // Then replace(/^\//, '') => 'h'
    expect(toRelativePath('/other/path', '/home/user')).toBe('h')
  })

  it('handles root-level files', () => {
    expect(toRelativePath('/home/user/file.txt', '/home/user')).toBe('file.txt')
  })

  it('handles deeply nested relative paths', () => {
    expect(toRelativePath('/a/b/c/d/e/f', '/a/b')).toBe('c/d/e/f')
  })

  it('handles single-level base', () => {
    expect(toRelativePath('/home/project', '/home')).toBe('project')
  })

  it('handles path that is just base with trailing slash', () => {
    // absPath = '/home/user/', base = '/home/user' => slice result = '/', then replace(/^\\//, '') => '', then || '/' => '/'
    expect(toRelativePath('/home/user/', '/home/user')).toBe('/')
  })
})
