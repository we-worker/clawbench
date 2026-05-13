import { describe, expect, it, vi } from 'vitest'

// Mock vue-i18n
const mockT = vi.fn((key: string, params?: Record<string, unknown>) => {
  if (key === 'test.key') return 'Test Value'
  if (key === 'test.withParams') return `Hello ${params?.name}`
  return key
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: { value: 'zh' },
    t: mockT,
  }),
}))

vi.mock('@/i18n', () => ({
  default: {
    global: { t: mockT },
  },
  STORAGE_KEY: 'clawbench-locale',
  setLocaleCookie: vi.fn(),
}))

describe('useLocale', () => {
  describe('gt', () => {
    it('translates a key using the global i18n instance', async () => {
      const { gt } = await import('@/composables/useLocale')
      const result = gt('test.key')
      expect(mockT).toHaveBeenCalledWith('test.key', undefined)
      expect(result).toBe('Test Value')
    })

    it('passes params to the translation function', async () => {
      mockT.mockClear()
      const { gt } = await import('@/composables/useLocale')
      gt('test.withParams', { name: 'World' })
      expect(mockT).toHaveBeenCalledWith('test.withParams', { name: 'World' })
    })

    it('returns the key when no translation exists', async () => {
      mockT.mockClear()
      mockT.mockImplementation((key: string) => key)
      const { gt } = await import('@/composables/useLocale')
      const result = gt('nonexistent.key')
      expect(result).toBe('nonexistent.key')
    })
  })
})
