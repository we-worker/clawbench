import { describe, expect, it } from 'vitest'
import { getFileType, formatFileSize } from '@/utils/fileType.ts'

describe('getFileType', () => {
  it('detects Go files', () => {
    const ft = getFileType('main.go')
    expect(ft.lang).toBe('go')
    expect(ft.label).toBe('Go')
    expect(ft.isMarkdown).toBe(false)
  })

  it('detects TypeScript files', () => {
    const ft = getFileType('app.ts')
    expect(ft.lang).toBe('typescript')
    expect(ft.label).toBe('TS')
  })

  it('detects markdown files', () => {
    const ft = getFileType('README.md')
    expect(ft.lang).toBe('markdown')
    expect(ft.isMarkdown).toBe(true)
  })

  it('detects PNG images', () => {
    const ft = getFileType('screenshot.png')
    expect(ft.isImage).toBe(true)
    expect(ft.lang).toBe('image')
  })

  it('detects JPG images (case insensitive)', () => {
    const ft = getFileType('photo.JPG')
    expect(ft.isImage).toBe(true)
  })

  it('detects MP3 audio', () => {
    const ft = getFileType('song.mp3')
    expect(ft.isAudio).toBe(true)
  })

  it('detects MP4 video', () => {
    const ft = getFileType('clip.mp4')
    expect(ft.isVideo).toBe(true)
  })

  it('detects PDF as image (viewable)', () => {
    const ft = getFileType('doc.pdf')
    expect(ft.isImage).toBe(true)
  })

  it('detects YAML files', () => {
    const ft = getFileType('config.yaml')
    expect(ft.lang).toBe('yaml')
  })

  it('detects JSON files', () => {
    const ft = getFileType('package.json')
    expect(ft.lang).toBe('json')
  })

  it('detects Vue files', () => {
    const ft = getFileType('App.vue')
    expect(ft.lang).toBe('vue')
  })

  it('returns plaintext for unknown extensions', () => {
    const ft = getFileType('data.xyz')
    expect(ft.lang).toBe('plaintext')
    expect(ft.label).toBe('TXT')
  })

  it('returns plaintext for files with no extension', () => {
    const ft = getFileType('Makefile')
    expect(ft.lang).toBe('plaintext')
  })

  it('detects Dockerfile by extension', () => {
    const ft = getFileType('Dockerfile.dockerfile')
    expect(ft.lang).toBe('dockerfile')
  })

  it('handles files with multiple dots', () => {
    const ft = getFileType('test.spec.ts')
    expect(ft.lang).toBe('typescript')
  })

  it('detects shell scripts', () => {
    const ft = getFileType('deploy.sh')
    expect(ft.lang).toBe('bash')
  })

  it('detects SQL files', () => {
    const ft = getFileType('query.sql')
    expect(ft.lang).toBe('sql')
  })
})

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('formats small bytes', () => {
    expect(formatFileSize(512)).toBe('512 B')
  })

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
  })

  it('formats large kilobytes', () => {
    expect(formatFileSize(512 * 1024)).toBe('512.0 KB')
  })

  it('formats megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
  })

  it('formats large megabytes', () => {
    expect(formatFileSize(50 * 1024 * 1024)).toBe('50.0 MB')
  })

  it('formats fractional KB', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB')
  })
})
