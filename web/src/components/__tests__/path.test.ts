import { describe, expect, it } from 'vitest'
import { baseName, dirName, splitPath } from '@/utils/path.ts'

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
    // splitPath('/home/user/') => ['', 'home', 'user', '']
    // pop() returns '' for trailing slash, falls back to original path
    const result = baseName('/home/user/')
    // Empty string from pop, should fallback to the path itself
    expect(result).toBe('/home/user/')
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
    // C:\file.txt -> parts = ['C:', 'file.txt'], pop -> ['C:'], result = 'C:' -> 'C:\'
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
    // The function checks if path includes backslash and not forward slash
    expect(dirName('a\\b\\c')).toBe('a\\b')
  })
})
