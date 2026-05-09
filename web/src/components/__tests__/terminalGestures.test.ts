import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { shouldPreventTerminalContextMenu, useTerminalGestures } from '@/composables/useTerminalGestures'

function makeTouch(clientX: number, clientY: number): Touch {
  return { clientX, clientY } as Touch
}

function makeTouchEvent(
  type: string,
  touches: Touch[],
  changedTouches: Touch[] = touches
): TouchEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent & { preventDefault: ReturnType<typeof vi.fn> }
  Object.defineProperty(event, 'touches', { value: touches })
  Object.defineProperty(event, 'changedTouches', { value: changedTouches })
  event.preventDefault = vi.fn()
  return event
}

function dispatchTouch(
  el: HTMLElement,
  type: string,
  touches: Touch[],
  changedTouches: Touch[] = touches
) {
  const event = makeTouchEvent(type, touches, changedTouches)
  el.dispatchEvent(event)
  return event
}

function setupGestures() {
  const el = document.createElement('div')
  document.body.appendChild(el)

  const sent: string[] = []
  const hints: string[] = []
  const zoomDeltas: number[] = []
  const gestures = useTerminalGestures(ref(el), {
    sendArrowUp: () => sent.push('up'),
    sendArrowDown: () => sent.push('down'),
    sendArrowLeft: () => sent.push('left'),
    sendArrowRight: () => sent.push('right'),
    sendTab: () => sent.push('tab'),
    onPinchZoom: (delta) => zoomDeltas.push(delta),
    onGestureHint: (symbol) => hints.push(symbol),
  })
  gestures.attach()

  return { el, sent, hints, zoomDeltas, gestures }
}

describe('useTerminalGestures', () => {
  it('prevents the native double-tap selection side effect when sending Tab', () => {
    const { el, sent, hints } = setupGestures()

    dispatchTouch(el, 'touchstart', [makeTouch(40, 40)])
    dispatchTouch(el, 'touchend', [], [makeTouch(40, 40)])
    dispatchTouch(el, 'touchstart', [makeTouch(42, 42)])
    const secondTapEnd = dispatchTouch(el, 'touchend', [], [makeTouch(42, 42)])

    expect(sent).toEqual(['tab'])
    expect(hints).toEqual(['⇥'])
    expect(secondTapEnd.preventDefault).toHaveBeenCalled()
  })

  it('does not prevent default touch handling for a stationary long press', () => {
    const { el, sent, zoomDeltas } = setupGestures()

    dispatchTouch(el, 'touchstart', [makeTouch(60, 60)])
    const touchEnd = dispatchTouch(el, 'touchend', [], [makeTouch(60, 60)])

    expect(sent).toEqual([])
    expect(zoomDeltas).toEqual([])
    expect(touchEnd.preventDefault).not.toHaveBeenCalled()
  })

  it('prevents native selection/scroll only after a swipe gesture is recognized', () => {
    const { el, sent } = setupGestures()

    dispatchTouch(el, 'touchstart', [makeTouch(100, 100)])
    const smallMove = dispatchTouch(el, 'touchmove', [makeTouch(108, 102)])
    const swipeMove = dispatchTouch(el, 'touchmove', [makeTouch(150, 102)])

    expect(sent).toEqual(['right'])
    expect(smallMove.preventDefault).not.toHaveBeenCalled()
    expect(swipeMove.preventDefault).toHaveBeenCalled()
  })

  it('prevents native pinch handling while applying terminal zoom', () => {
    const { el, zoomDeltas } = setupGestures()

    const pinchStart = dispatchTouch(el, 'touchstart', [makeTouch(0, 0), makeTouch(20, 0)])
    const pinchMove = dispatchTouch(el, 'touchmove', [makeTouch(0, 0), makeTouch(40, 0)])

    expect(zoomDeltas).toEqual([2])
    expect(pinchStart.preventDefault).toHaveBeenCalled()
    expect(pinchMove.preventDefault).toHaveBeenCalled()
  })

  it('restores fully native touch handling when gestures are disabled', () => {
    const { el, gestures } = setupGestures()

    gestures.toggle()

    expect(gestures.enabled.value).toBe(false)
    expect(el.style.touchAction).toBe('auto')
  })

  it('does not disable native touch selection when gestures are toggled back on', () => {
    const { el, gestures } = setupGestures()

    gestures.toggle()
    expect(gestures.enabled.value).toBe(false)
    gestures.toggle()

    expect(gestures.enabled.value).toBe(true)
    expect(el.style.touchAction).not.toBe('none')
  })
})

describe('shouldPreventTerminalContextMenu', () => {
  it('allows the native long-press copy menu when gestures are disabled', () => {
    expect(shouldPreventTerminalContextMenu(false)).toBe(false)
  })

  it('suppresses the native context menu while gestures are enabled', () => {
    expect(shouldPreventTerminalContextMenu(true)).toBe(true)
  })
})
