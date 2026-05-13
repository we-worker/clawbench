/**
 * PopupMenu positioning utilities — pure functions for computing
 * the fixed-position style of a popup menu relative to an anchor element.
 *
 * Extracted from PopupMenu.vue for testability.
 */

/**
 * Compute the CSS style object for a popup menu's fixed position.
 *
 * @param rect - The getBoundingClientRect() of the anchor element
 * @param opts - Positioning options
 * @returns A CSS style object suitable for binding to the menu element
 */
export function computeMenuStyle(
  rect: DOMRect,
  opts: {
    anchor?: 'left' | 'right'
    maxWidth?: number
    maxHeight?: number
    edgeMargin?: number
    menuItemsCount?: number
    viewportWidth?: number
    viewportHeight?: number
  } = {}
): Record<string, string> {
  const {
    anchor = 'left',
    maxWidth = 220,
    maxHeight = 320,
    edgeMargin = 6,
    menuItemsCount = 10,
    viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024,
    viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768,
  } = opts

  const estMenuHeight = 36 + menuItemsCount * 28

  if (anchor === 'right') {
    let right = viewportWidth - rect.right
    if (right + maxWidth + edgeMargin > viewportWidth) {
      right = viewportWidth - maxWidth - edgeMargin
    }
    right = Math.max(edgeMargin, right)

    let bottom = viewportHeight - rect.top + 4
    if (viewportHeight - bottom < edgeMargin) {
      bottom = viewportHeight - rect.bottom - 4 - estMenuHeight
      if (viewportHeight - bottom - estMenuHeight < edgeMargin) {
        bottom = viewportHeight - estMenuHeight - edgeMargin
      }
    }

    return {
      position: 'fixed',
      bottom: `${bottom}px`,
      right: `${right}px`,
      maxWidth: `${maxWidth}px`,
      maxHeight: `min(${maxHeight}px, calc(100vh - ${edgeMargin * 2}px))`,
      overflowY: 'auto',
    }
  }

  // Left-aligned (default)
  let left = rect.left
  if (left + maxWidth + edgeMargin > viewportWidth) {
    left = viewportWidth - maxWidth - edgeMargin
  }
  left = Math.max(edgeMargin, left)

  let bottom = viewportHeight - rect.top + 4
  if (viewportHeight - bottom < edgeMargin) {
    bottom = viewportHeight - rect.bottom - 4 - estMenuHeight
    if (viewportHeight - bottom - estMenuHeight < edgeMargin) {
      bottom = viewportHeight - estMenuHeight - edgeMargin
    }
  }

  return {
    position: 'fixed',
    bottom: `${bottom}px`,
    left: `${left}px`,
    maxWidth: `${maxWidth}px`,
    maxHeight: `min(${maxHeight}px, calc(100vh - ${edgeMargin * 2}px))`,
    overflowY: 'auto',
  }
}
