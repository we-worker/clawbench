import { type Ref } from 'vue'

export interface GestureCallbacks {
  sendArrowUp: () => void
  sendArrowDown: () => void
  sendArrowLeft: () => void
  sendArrowRight: () => void
  sendTab: () => void
}

/**
 * Termius-style touch gestures for the terminal area.
 * - Swipe left/right → arrow left/right
 * - Swipe up/down → arrow up/down
 * - Double-tap → Tab
 *
 * Gestures are bound only to the xterm container element,
 * not the entire BottomSheet, to avoid conflicting with drawer drag.
 */
export function useTerminalGestures(
  elementRef: Ref<HTMLElement | null>,
  callbacks: GestureCallbacks
) {
  const SWIPE_THRESHOLD = 30 // minimum px for a swipe
  const SWIPE_MAX_TIME = 400 // max ms for a swipe gesture
  const DOUBLE_TAP_DELAY = 300 // max ms between taps for double-tap

  let touchStartX = 0
  let touchStartY = 0
  let touchStartTime = 0
  let lastTapTime = 0
  let isActive = false

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) return

    const touch = e.touches[0]
    touchStartX = touch.clientX
    touchStartY = touch.clientY
    touchStartTime = Date.now()
    isActive = true
  }

  function onTouchEnd(e: TouchEvent) {
    if (!isActive) return
    isActive = false

    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    const dt = Date.now() - touchStartTime
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)

    // Check for double-tap first (small movement, short time)
    if (absDx < 10 && absDy < 10 && dt < 200) {
      const now = Date.now()
      if (now - lastTapTime < DOUBLE_TAP_DELAY) {
        // Double-tap detected → send Tab
        callbacks.sendTab()
        lastTapTime = 0 // reset to prevent triple-tap
        return
      }
      lastTapTime = now
      return
    }

    // Check for swipe (must exceed threshold and be quick enough)
    if (dt > SWIPE_MAX_TIME) return
    if (absDx < SWIPE_THRESHOLD && absDy < SWIPE_THRESHOLD) return

    // Determine swipe direction (the larger axis wins)
    if (absDx > absDy) {
      // Horizontal swipe
      if (dx > 0) {
        callbacks.sendArrowRight()
      } else {
        callbacks.sendArrowLeft()
      }
    } else {
      // Vertical swipe
      if (dy > 0) {
        callbacks.sendArrowDown()
      } else {
        callbacks.sendArrowUp()
      }
    }
  }

  function attach() {
    const el = elementRef.value
    if (!el) return

    // Use passive: true to avoid blocking scroll performance,
    // but we don't call preventDefault so this is safe
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
  }

  function detach() {
    const el = elementRef.value
    if (!el) return

    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchend', onTouchEnd)
  }

  return {
    attach,
    detach,
  }
}
