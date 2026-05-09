import { ref, type Ref } from 'vue'

export interface GestureCallbacks {
  sendArrowUp: () => void
  sendArrowDown: () => void
  sendArrowLeft: () => void
  sendArrowRight: () => void
  sendTab: () => void
  onPinchZoom?: (delta: number) => void
  onGestureHint?: (symbol: string) => void
}

type Direction = 'up' | 'down' | 'left' | 'right'

export function shouldPreventTerminalContextMenu(gesturesEnabled: boolean): boolean {
  return gesturesEnabled
}

/**
 * Termius-style touch gestures for the terminal area.
 * - Swipe left/right → arrow left/right
 * - Swipe up/down → arrow up/down
 * - Hold direction → auto-repeat arrow keys
 * - Double-tap → Tab
 * - Pinch (two-finger) → zoom font size
 *
 * When gestures are disabled, all touch listeners are detached so that
 * xterm.js native touch selection (long-press to select) works normally.
 *
 * Gestures are bound only to the xterm container element,
 * not the entire BottomSheet, to avoid conflicting with drawer drag.
 */
export function useTerminalGestures(
  elementRef: Ref<HTMLElement | null>,
  callbacks: GestureCallbacks
) {
  const SWIPE_THRESHOLD = 30 // minimum px for a swipe
  const PINCH_THRESHOLD = 10 // minimum px change before triggering zoom
  const REPEAT_INITIAL_DELAY = 500 // ms before auto-repeat starts
  const REPEAT_INTERVAL = 150 // ms between repeated arrow keys
  const DOUBLE_TAP_MS = 300 // max ms between two taps for double-tap
  const TAP_THRESHOLD = 10 // max px movement to still count as a tap

  // Gesture enable/disable state
  const enabled = ref(true)
  let listenersAttached = false

  let touchStartX = 0
  let touchStartY = 0
  let isActive = false

  // Direction tracking for hold-to-repeat
  let currentDirection: Direction | null = null
  let repeatTimer: ReturnType<typeof setTimeout> | null = null
  let repeatInterval: ReturnType<typeof setInterval> | null = null

  // Pinch zoom state
  let initialPinchDistance = 0
  let lastPinchDistance = 0
  let accumulatedPinchDelta = 0

  // Double-tap Tab state
  let lastTapTime = 0
  let lastTapX = 0
  let lastTapY = 0

  function getTouchDistance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX
    const dy = t1.clientY - t2.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const DIRECTION_SYMBOLS: Record<Direction, string> = {
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  }

  function sendArrow(dir: Direction) {
    switch (dir) {
      case 'up': callbacks.sendArrowUp(); break
      case 'down': callbacks.sendArrowDown(); break
      case 'left': callbacks.sendArrowLeft(); break
      case 'right': callbacks.sendArrowRight(); break
    }
    callbacks.onGestureHint?.(DIRECTION_SYMBOLS[dir])
  }

  function startRepeat(dir: Direction) {
    stopRepeat()
    repeatTimer = setTimeout(() => {
      repeatInterval = setInterval(() => {
        sendArrow(dir)
      }, REPEAT_INTERVAL)
    }, REPEAT_INITIAL_DELAY)
  }

  function stopRepeat() {
    if (repeatTimer) {
      clearTimeout(repeatTimer)
      repeatTimer = null
    }
    if (repeatInterval) {
      clearInterval(repeatInterval)
      repeatInterval = null
    }
  }

  function detectDirection(dx: number, dy: number): Direction | null {
    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)
    if (absDx < SWIPE_THRESHOLD && absDy < SWIPE_THRESHOLD) return null
    if (absDx > absDy) {
      return dx > 0 ? 'right' : 'left'
    } else {
      return dy > 0 ? 'down' : 'up'
    }
  }

  function preventNativeTouch(e: TouchEvent) {
    if (e.cancelable) {
      e.preventDefault()
    }
  }

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
      // Pinch gesture start. Prevent browser pinch/selection only once a
      // terminal gesture is clear; stationary single-finger long press is left
      // untouched so xterm/browser text selection can still start normally.
      preventNativeTouch(e)
      initialPinchDistance = getTouchDistance(e.touches[0], e.touches[1])
      lastPinchDistance = initialPinchDistance
      accumulatedPinchDelta = 0
      isActive = false // cancel any single-finger gesture
      stopRepeat()
      currentDirection = null
      return
    }

    if (e.touches.length !== 1) return

    const touch = e.touches[0]
    touchStartX = touch.clientX
    touchStartY = touch.clientY
    isActive = true
    currentDirection = null
  }

  function onTouchMove(e: TouchEvent) {
    // Pinch zoom
    if (e.touches.length === 2 && initialPinchDistance > 0) {
      preventNativeTouch(e)
      const currentDistance = getTouchDistance(e.touches[0], e.touches[1])
      const delta = currentDistance - lastPinchDistance
      accumulatedPinchDelta += delta
      lastPinchDistance = currentDistance

      if (Math.abs(accumulatedPinchDelta) >= PINCH_THRESHOLD) {
        const steps = Math.trunc(accumulatedPinchDelta / PINCH_THRESHOLD)
        callbacks.onPinchZoom?.(steps)
        accumulatedPinchDelta -= steps * PINCH_THRESHOLD
      }
      return
    }

    if (!isActive || e.touches.length !== 1) return

    // Direction detection for hold-to-repeat
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    const dir = detectDirection(dx, dy)

    if (dir || currentDirection) {
      // Once the movement is clearly a terminal gesture, suppress native
      // selection/scroll for the remainder of the gesture. Before the
      // threshold is crossed, do not prevent default so long-press selection
      // can start normally.
      preventNativeTouch(e)
    }

    if (dir && dir !== currentDirection) {
      // Direction changed or first detection — send once and start repeat
      currentDirection = dir
      sendArrow(dir)
      startRepeat(dir)
    }
  }

  function onTouchEnd(e: TouchEvent) {
    // Reset pinch state when one or both fingers lift
    if (e.touches.length < 2) {
      initialPinchDistance = 0
      lastPinchDistance = 0
    }

    // Stop any hold-to-repeat
    stopRepeat()

    if (!isActive) return

    const wasDirection = currentDirection
    currentDirection = null
    isActive = false

    // If direction was already handled in touchmove (hold-to-repeat),
    // skip the legacy swipe-on-touchend logic
    if (wasDirection) {
      preventNativeTouch(e)
      return
    }

    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    const dir = detectDirection(dx, dy)
    if (dir) {
      // It's a swipe — send the arrow key
      preventNativeTouch(e)
      sendArrow(dir)
    } else if (Math.abs(dx) <= TAP_THRESHOLD && Math.abs(dy) <= TAP_THRESHOLD) {
      // It's a tap (no significant movement) — check for double-tap
      const now = Date.now()
      const tapDx = touch.clientX - lastTapX
      const tapDy = touch.clientY - lastTapY
      const isDoubleTap = (now - lastTapTime) < DOUBLE_TAP_MS
        && Math.abs(tapDx) < TAP_THRESHOLD * 2
        && Math.abs(tapDy) < TAP_THRESHOLD * 2
      if (isDoubleTap) {
        preventNativeTouch(e)
        callbacks.sendTab()
        callbacks.onGestureHint?.('⇥')
        lastTapTime = 0 // reset to avoid triple-tap
      } else {
        lastTapTime = now
        lastTapX = touch.clientX
        lastTapY = touch.clientY
      }
    }
  }

  function attachListeners() {
    if (listenersAttached) return
    const el = elementRef.value
    if (!el) return

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd, { passive: false })
    listenersAttached = true
  }

  function detachListeners() {
    if (!listenersAttached) return
    const el = elementRef.value
    if (!el) return

    stopRepeat()
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    listenersAttached = false
  }

  // Apply gesture state: attach when enabled, detach when disabled.
  // Keep touch-action permissive enough for long-press/native selection; the
  // handlers call preventDefault only after recognizing a terminal gesture.
  function applyState() {
    const el = elementRef.value
    if (enabled.value) {
      attachListeners()
      if (el) el.style.touchAction = 'manipulation'
    } else {
      detachListeners()
      // Restore fully native touch handling so long-press can open the
      // platform selection/copy UI instead of only allowing vertical panning.
      if (el) el.style.touchAction = 'auto'
    }
  }

  function toggle() {
    enabled.value = !enabled.value
    if (!enabled.value) {
      stopRepeat()
      isActive = false
      currentDirection = null
      lastTapTime = 0
    }
    applyState()
  }

  // Called by TerminalPanel on mount
  function attach() {
    applyState()
  }

  // Called by TerminalPanel on unmount
  function detach() {
    detachListeners()
    const el = elementRef.value
    if (el) el.style.touchAction = ''
  }

  return {
    attach,
    detach,
    enabled,
    toggle,
  }
}
