import { ref, type Ref } from 'vue'
import type { Terminal } from '@xterm/xterm'

export function useTerminalViewport(terminal: Ref<Terminal | null>, containerRef: Ref<HTMLElement | null>) {
  const viewportHeight = ref(0)
  const keyboardHeight = ref(0)

  function updateViewport() {
    if (!containerRef.value) return

    // Use visualViewport on mobile for accurate height with keyboard
    const vv = window.visualViewport
    if (vv) {
      const fullHeight = window.innerHeight
      keyboardHeight.value = fullHeight - vv.height - vv.offsetTop
      viewportHeight.value = vv.height
    } else {
      viewportHeight.value = containerRef.value.clientHeight
      keyboardHeight.value = 0
    }

    fitTerminal()
  }

  function fitTerminal() {
    if (!terminal.value || !containerRef.value) return
    try {
      // @ts-ignore — FitAddon is loaded dynamically
      terminal.value.fitAddon?.fit()
    } catch {
      // fit() can fail if terminal is not visible
    }
  }

  let resizeObserver: ResizeObserver | null = null

  function startWatching() {
    updateViewport()

    // Watch container size changes
    if (containerRef.value) {
      resizeObserver = new ResizeObserver(() => {
        updateViewport()
      })
      resizeObserver.observe(containerRef.value)
    }

    // Watch visualViewport for keyboard changes
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport)
      window.visualViewport.addEventListener('scroll', updateViewport)
    }
  }

  function stopWatching() {
    resizeObserver?.disconnect()
    resizeObserver = null

    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', updateViewport)
      window.visualViewport.removeEventListener('scroll', updateViewport)
    }
  }

  return {
    viewportHeight,
    keyboardHeight,
    fitTerminal,
    startWatching,
    stopWatching,
  }
}
