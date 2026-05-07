import { ref, type Ref } from 'vue'

export type ModifierKey = 'ctrl' | 'alt' | 'shift'
export type ModifierState = 'inactive' | 'once' | 'locked'

export function useTerminalKeys(sendInput: (data: string) => void) {
  const modifiers: Record<ModifierKey, ModifierState> = {
    ctrl: 'inactive',
    alt: 'inactive',
    shift: 'inactive',
  }
  const activeModifiers = ref<Record<ModifierKey, ModifierState>>({ ...modifiers })

  function toggleModifier(key: ModifierKey, isLongPress: boolean) {
    const current = modifiers[key]
    if (current === 'inactive') {
      modifiers[key] = isLongPress ? 'locked' : 'once'
    } else if (current === 'once') {
      if (isLongPress) {
        modifiers[key] = 'locked'
      } else {
        modifiers[key] = 'inactive'
      }
    } else {
      // locked -> deactivate
      modifiers[key] = 'inactive'
    }
    activeModifiers.value = { ...modifiers }
  }

  function clearOnceModifiers() {
    let changed = false
    for (const key of ['ctrl', 'alt', 'shift'] as ModifierKey[]) {
      if (modifiers[key] === 'once') {
        modifiers[key] = 'inactive'
        changed = true
      }
    }
    if (changed) {
      activeModifiers.value = { ...modifiers }
    }
  }

  // Transform a character input based on active modifiers
  function processInput(data: string): string {
    // If no modifiers active, pass through
    if (modifiers.ctrl === 'inactive' && modifiers.alt === 'inactive' && modifiers.shift === 'inactive') {
      return data
    }

    // Handle Ctrl combinations
    if (modifiers.ctrl !== 'inactive') {
      const char = data.toLowerCase()
      if (char.length === 1 && char >= 'a' && char <= 'z') {
        const code = char.charCodeAt(0) - 96 // Ctrl+A = \x01, Ctrl+Z = \x1a
        clearOnceModifiers()
        return String.fromCharCode(code)
      }
      // Special cases
      if (char === '[') { clearOnceModifiers(); return '\x1b' }
      if (char === '\\') { clearOnceModifiers(); return '\x1c' }
      if (char === ']') { clearOnceModifiers(); return '\x1d' }
      if (char === '@') { clearOnceModifiers(); return '\x00' }
      if (char === '^') { clearOnceModifiers(); return '\x1e' }
      if (char === '_') { clearOnceModifiers(); return '\x1f' }
    }

    // Handle Alt combinations
    if (modifiers.alt !== 'inactive') {
      if (data.length === 1) {
        clearOnceModifiers()
        return `\x1b${data}`
      }
    }

    // Handle Shift combinations
    if (modifiers.shift !== 'inactive') {
      if (data === '\t') { // Shift+Tab
        clearOnceModifiers()
        return '\x1b[Z'
      }
    }

    clearOnceModifiers()
    return data
  }

  // Special key sends
  function sendCtrlC() {
    sendInput('\x03')
  }

  function sendEscape() {
    sendInput('\x1b')
  }

  function sendTab() {
    sendInput('\t')
  }

  function sendArrowUp() {
    sendInput('\x1b[A')
  }

  function sendArrowDown() {
    sendInput('\x1b[B')
  }

  function sendArrowRight() {
    sendInput('\x1b[C')
  }

  function sendArrowLeft() {
    sendInput('\x1b[D')
  }

  function reset() {
    modifiers.ctrl = 'inactive'
    modifiers.alt = 'inactive'
    modifiers.shift = 'inactive'
    activeModifiers.value = { ...modifiers }
  }

  return {
    activeModifiers,
    toggleModifier,
    processInput,
    clearOnceModifiers,
    sendCtrlC,
    sendEscape,
    sendTab,
    sendArrowUp,
    sendArrowDown,
    sendArrowRight,
    sendArrowLeft,
    reset,
  }
}
