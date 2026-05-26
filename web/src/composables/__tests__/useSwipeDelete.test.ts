import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useSwipeDelete, DELETE_WIDTH } from '@/composables/useSwipeDelete'

function createTouchEvent(type: string, x: number, y: number, changedX?: number, changedY?: number) {
  const touch = { clientX: x, clientY: y }
  const changedTouch = { clientX: changedX ?? x, clientY: changedY ?? y }
  return {
    touches: [touch],
    changedTouches: [changedTouch],
    preventDefault: vi.fn(),
  } as unknown as TouchEvent
}

describe('useSwipeDelete', () => {
  let swipe: ReturnType<typeof useSwipeDelete>

  beforeEach(() => {
    swipe = useSwipeDelete()
  })

  it('starts with offset 0 and isRevealed false', () => {
    expect(swipe.offset.value).toBe(0)
    expect(swipe.isRevealed.value).toBe(false)
  })

  it('close resets offset to 0 and isRevealed to false', () => {
    // Simulate a full left swipe to reveal
    swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
    swipe.onTouchMove(createTouchEvent('touchmove', 100, 100))
    swipe.onTouchEnd(createTouchEvent('touchend', 200, 100, 100, 100))

    // Should be revealed now
    expect(swipe.isRevealed.value).toBe(true)

    // Close it
    swipe.close()
    expect(swipe.offset.value).toBe(0)
    expect(swipe.isRevealed.value).toBe(false)
  })

  it('onContentClick returns false when not revealed', () => {
    const consumed = swipe.onContentClick()
    expect(consumed).toBe(false)
  })

  it('onContentClick returns true and closes when revealed', () => {
    // Reveal by swiping
    swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
    swipe.onTouchMove(createTouchEvent('touchmove', 100, 100))
    swipe.onTouchEnd(createTouchEvent('touchend', 200, 100, 100, 100))
    expect(swipe.isRevealed.value).toBe(true)

    const consumed = swipe.onContentClick()
    expect(consumed).toBe(true)
    expect(swipe.offset.value).toBe(0)
    expect(swipe.isRevealed.value).toBe(false)
  })

  describe('swipe left to reveal', () => {
    it('swiping left past threshold reveals delete button', () => {
      swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
      const moveEvent = createTouchEvent('touchmove', 100, 100)
      swipe.onTouchMove(moveEvent)
      expect(moveEvent.preventDefault).toHaveBeenCalled()

      swipe.onTouchEnd(createTouchEvent('touchend', 200, 100, 100, 100))
      expect(swipe.isRevealed.value).toBe(true)
      expect(swipe.offset.value).toBe(-DELETE_WIDTH)
    })
  })

  describe('swipe right to close', () => {
    it('swiping right on revealed item closes it', () => {
      // First reveal
      swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
      swipe.onTouchMove(createTouchEvent('touchmove', 100, 100))
      swipe.onTouchEnd(createTouchEvent('touchend', 200, 100, 100, 100))
      expect(swipe.isRevealed.value).toBe(true)

      // Now swipe right to close
      swipe.onTouchStart(createTouchEvent('touchstart', 100, 100))
      swipe.onTouchMove(createTouchEvent('touchmove', 200, 100))
      swipe.onTouchEnd(createTouchEvent('touchend', 100, 100, 200, 100))

      expect(swipe.isRevealed.value).toBe(false)
      expect(swipe.offset.value).toBe(0)
    })
  })

  describe('small swipe does not reveal', () => {
    it('swiping only slightly left does not reveal', () => {
      // Move only 15px left, well below half of DELETE_WIDTH (35px)
      swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
      swipe.onTouchMove(createTouchEvent('touchmove', 185, 100))
      swipe.onTouchEnd(createTouchEvent('touchend', 200, 100, 190, 100))

      expect(swipe.isRevealed.value).toBe(false)
      expect(swipe.offset.value).toBe(0)
    })
  })

  describe('vertical swipe is ignored', () => {
    it('vertical movement does not trigger swipe', () => {
      swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
      swipe.onTouchMove(createTouchEvent('touchmove', 200, 300))
      swipe.onTouchEnd(createTouchEvent('touchend', 200, 100, 200, 300))

      expect(swipe.isRevealed.value).toBe(false)
      expect(swipe.offset.value).toBe(0)
    })
  })

  describe('offset clamping', () => {
    it('offset cannot go past 0 (right of origin)', () => {
      swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
      swipe.onTouchMove(createTouchEvent('touchmove', 300, 100))
      // Should be clamped to 0
      expect(swipe.offset.value).toBe(0)
    })

    it('offset cannot go past -DELETE_WIDTH', () => {
      swipe.onTouchStart(createTouchEvent('touchstart', 200, 100))
      swipe.onTouchMove(createTouchEvent('touchmove', 50, 100))
      // Should be clamped to -DELETE_WIDTH
      expect(swipe.offset.value).toBe(-DELETE_WIDTH)
    })
  })
})
