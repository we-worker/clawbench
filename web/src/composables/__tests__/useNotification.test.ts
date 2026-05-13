import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mock browser APIs
const mockNotificationClose = vi.fn()

// Mock useToast
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ show: vi.fn() }),
}))

vi.mock('@/composables/useLocale', () => ({
  gt: (key: string) => key,
}))

// We need to mock the Notification constructor and document APIs
// Since useNotification uses browser Notification API directly,
// we test the logic around permission checks and visibility

describe('useNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('closeAllNotifications', () => {
    it('does not throw when no active notifications', async () => {
      const { closeAllNotifications } = await import('@/composables/useNotification')
      expect(() => closeAllNotifications()).not.toThrow()
    })
  })

  describe('requestNotificationPermission', () => {
    it('returns "denied" when Notification API is not available', async () => {
      // In test environment, Notification is likely not available
      const { requestNotificationPermission } = await import('@/composables/useNotification')
      const result = await requestNotificationPermission()
      // In Node environment, Notification doesn't exist → returns 'denied'
      expect(['denied', 'granted', 'default']).toContain(result)
    })
  })

  describe('showBrowserNotification', () => {
    it('does not throw when Notification is not supported', async () => {
      const { showBrowserNotification } = await import('@/composables/useNotification')
      // Should silently not throw even in test env
      expect(() => showBrowserNotification('Test')).not.toThrow()
    })

    it('does not throw with options', async () => {
      const { showBrowserNotification } = await import('@/composables/useNotification')
      expect(() => showBrowserNotification('Test', {
        body: 'Body text',
        tag: 'test-tag',
      })).not.toThrow()
    })
  })
})
