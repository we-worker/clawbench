import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getFileType } from '@/utils/fileType.ts'

// ─── Thumbnail URL generation ───
// These tests verify the thumb URL builder that will be used by FileManagerContent.
// The function is simple enough to test inline; once extracted to a util, import it.

function buildThumbUrl(currentDir: string, entryName: string, width = 200): string {
  const path = (currentDir ? currentDir + '/' : '') + entryName
  return `/api/file/thumb?path=${encodeURIComponent(path)}&w=${width}`
}

// ─── Image type detection (mirrors FileManagerContent.isImage) ───
function isImage(entry: { type: string; name: string }): boolean {
  return entry.type === 'image' || !!getFileType(entry.name).isImage
}

// ─── View mode persistence ───
type ViewMode = 'list' | 'grid'
const VIEW_MODE_KEY = 'clawbench-file-view'

function loadViewMode(): ViewMode {
  const stored = localStorage.getItem(VIEW_MODE_KEY)
  if (stored === 'list' || stored === 'grid') return stored
  return 'list'
}

function saveViewMode(mode: ViewMode): void {
  localStorage.setItem(VIEW_MODE_KEY, mode)
}

// ─── Tests ───

describe('buildThumbUrl', () => {
  it('builds correct URL for root-level image', () => {
    expect(buildThumbUrl('', 'photo.png')).toBe('/api/file/thumb?path=photo.png&w=200')
  })

  it('builds correct URL for nested image', () => {
    expect(buildThumbUrl('assets/img', 'logo.png')).toBe('/api/file/thumb?path=assets%2Fimg%2Flogo.png&w=200')
  })

  it('respects custom width parameter', () => {
    expect(buildThumbUrl('', 'photo.jpg', 400)).toBe('/api/file/thumb?path=photo.jpg&w=400')
  })

  it('encodes special characters in path', () => {
    expect(buildThumbUrl('my folder', 'test image.png')).toBe(
      '/api/file/thumb?path=my%20folder%2Ftest%20image.png&w=200'
    )
  })
})

describe('isImage (file type detection)', () => {
  it('detects PNG via backend type', () => {
    expect(isImage({ type: 'image', name: 'photo.png' })).toBe(true)
  })

  it('detects JPG via getFileType', () => {
    expect(isImage({ type: 'file', name: 'photo.jpg' })).toBe(true)
  })

  it('detects SVG via getFileType', () => {
    expect(isImage({ type: 'file', name: 'logo.svg' })).toBe(true)
  })

  it('returns false for non-image files', () => {
    expect(isImage({ type: 'file', name: 'readme.md' })).toBe(false)
  })

  it('returns false for directories', () => {
    expect(isImage({ type: 'dir', name: 'images' })).toBe(false)
  })

  it('detects case-insensitive extensions', () => {
    expect(isImage({ type: 'file', name: 'photo.PNG' })).toBe(true)
    expect(isImage({ type: 'file', name: 'photo.Jpg' })).toBe(true)
  })
})

describe('view mode persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to list mode when nothing stored', () => {
    expect(loadViewMode()).toBe('list')
  })

  it('loads grid mode from localStorage', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'grid')
    expect(loadViewMode()).toBe('grid')
  })

  it('loads list mode from localStorage', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'list')
    expect(loadViewMode()).toBe('list')
  })

  it('falls back to list for invalid stored values', () => {
    localStorage.setItem(VIEW_MODE_KEY, 'invalid')
    expect(loadViewMode()).toBe('list')
  })

  it('saves view mode to localStorage', () => {
    saveViewMode('grid')
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('grid')
  })

  it('overwrites previous value', () => {
    saveViewMode('grid')
    saveViewMode('list')
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('list')
  })
})

// ─── Thumbnail eligibility (mirrors FileManagerContent.isThumbable) ───
const THUMBABLE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif'])

function isThumbable(entry: { type: string; name: string }): boolean {
  if (entry.type !== 'image' && entry.type !== 'file') return false
  const name = entry.name.toLowerCase()
  for (const ext of THUMBABLE_EXTS) {
    if (name.endsWith(ext)) return true
  }
  return false
}

describe('isThumbable (thumbnail eligibility)', () => {
  it('allows PNG files', () => {
    expect(isThumbable({ type: 'image', name: 'photo.png' })).toBe(true)
  })

  it('allows JPG files', () => {
    expect(isThumbable({ type: 'file', name: 'photo.jpg' })).toBe(true)
  })

  it('allows GIF files', () => {
    expect(isThumbable({ type: 'file', name: 'anim.gif' })).toBe(true)
  })

  it('excludes SVG (vector, not raster)', () => {
    expect(isThumbable({ type: 'file', name: 'logo.svg' })).toBe(false)
  })

  it('excludes WebP (not in Go stdlib decoder)', () => {
    expect(isThumbable({ type: 'file', name: 'photo.webp' })).toBe(false)
  })

  it('excludes PDF files', () => {
    expect(isThumbable({ type: 'file', name: 'doc.pdf' })).toBe(false)
  })

  it('excludes directories', () => {
    expect(isThumbable({ type: 'dir', name: 'images' })).toBe(false)
  })

  it('excludes non-image files', () => {
    expect(isThumbable({ type: 'file', name: 'readme.md' })).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isThumbable({ type: 'image', name: 'photo.PNG' })).toBe(true)
    expect(isThumbable({ type: 'file', name: 'photo.JPG' })).toBe(true)
  })
})
