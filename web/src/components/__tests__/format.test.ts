import { describe, expect, it, vi, beforeEach } from 'vitest'

// ────────────────────────────────────────────────────────────
// formatDuration and statusLabel are pure functions we can test
// directly. formatRelativeTime, formatDateTime, humanizeCron,
// and repeatLabel depend on i18n which we need to mock.
// ────────────────────────────────────────────────────────────

// Import pure functions
import { formatDuration, statusLabel, humanizeCron, repeatLabel } from '@/utils/format.ts'

// Mock i18n module
vi.mock('@/i18n', () => ({
  default: {
    global: {
      t: (key: string, params?: any) => {
        // Simple mock: return key with params for verification
        if (key === 'cron.everyMinutes') return `Every ${params?.count} min`
        if (key === 'cron.everyHours') return `Every ${params?.count} hours`
        if (key === 'cron.daily') return `Daily at ${params?.time}`
        if (key === 'cron.weekdays') return `Weekdays at ${params?.time}`
        if (key === 'cron.weekly') return `${params?.day} at ${params?.time}`
        if (key === 'cron.monthly') return `Monthly on day ${params?.day} at ${params?.time}`
        if (key === 'cron.hourly') return `Hourly at :${params?.minute}`
        if (key === 'task.repeat.once') return 'Once'
        if (key === 'task.repeat.times') return `${params?.count} times`
        if (key === 'task.repeat.unlimited') return 'Unlimited'
        if (key === 'task.status.active') return 'Active'
        if (key === 'task.status.paused') return 'Paused'
        if (key === 'task.status.completed') return 'Completed'
        return key
      },
      locale: { value: 'en' },
    },
  },
}))

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms')
  })

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0ms')
  })

  it('formats seconds with one decimal', () => {
    expect(formatDuration(1500)).toBe('1.5s')
  })

  it('formats exact seconds', () => {
    expect(formatDuration(3000)).toBe('3.0s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(90000)).toBe('1m30s')
  })

  it('formats large duration', () => {
    expect(formatDuration(3723000)).toBe('62m3s')
  })

  it('formats exactly 60 seconds as 1m0s', () => {
    expect(formatDuration(60000)).toBe('1m0s')
  })
})

describe('humanizeCron', () => {
  it('returns raw expression for invalid length', () => {
    expect(humanizeCron('invalid')).toBe('invalid')
  })

  it('returns raw expression for 4-part cron', () => {
    expect(humanizeCron('* * * *')).toBe('* * * *')
  })

  it('parses every-N-minutes', () => {
    expect(humanizeCron('*/5 * * * *')).toBe('Every 5 min')
  })

  it('parses every-N-hours', () => {
    expect(humanizeCron('0 */2 * * *')).toBe('Every 2 hours')
  })

  it('parses daily schedule', () => {
    expect(humanizeCron('0 9 * * *')).toBe('Daily at 9:00')
  })

  it('parses weekday schedule', () => {
    expect(humanizeCron('0 9 * * 1-5')).toBe('Weekdays at 9:00')
  })

  it('returns raw expression for unrecognized pattern', () => {
    expect(humanizeCron('30 4 1 1 *')).toBe('30 4 1 1 *')
  })
})

describe('repeatLabel', () => {
  it('returns "Once" for once mode', () => {
    expect(repeatLabel('once', 0)).toBe('Once')
  })

  it('returns count for limited mode', () => {
    expect(repeatLabel('limited', 5)).toBe('5 times')
  })

  it('returns "Unlimited" for unlimited mode', () => {
    expect(repeatLabel('unlimited', 0)).toBe('Unlimited')
  })
})

describe('statusLabel', () => {
  it('returns "Active" for active status', () => {
    expect(statusLabel('active')).toBe('Active')
  })

  it('returns "Paused" for paused status', () => {
    expect(statusLabel('paused')).toBe('Paused')
  })

  it('returns "Completed" for completed status', () => {
    expect(statusLabel('completed')).toBe('Completed')
  })

  it('returns raw status for unknown status', () => {
    expect(statusLabel('unknown')).toBe('unknown')
  })
})
