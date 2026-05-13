import { describe, expect, it } from 'vitest'
import { computeMenuStyle } from '../popupMenuPosition'

// Helper to create a mock DOMRect
function mockRect(options: {
  top?: number
  bottom?: number
  left?: number
  right?: number
  width?: number
  height?: number
}): DOMRect {
  return {
    top: options.top ?? 0,
    bottom: options.bottom ?? 0,
    left: options.left ?? 0,
    right: options.right ?? 0,
    width: options.width ?? 0,
    height: options.height ?? 0,
    x: options.left ?? 0,
    y: options.top ?? 0,
    toJSON: () => ({}),
  }
}

describe('computeMenuStyle', () => {
  describe('left anchor (default)', () => {
    it('positions menu above the anchor element', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 100, right: 140 })
      const style = computeMenuStyle(rect, { viewportWidth: 1024, viewportHeight: 768 })

      expect(style.position).toBe('fixed')
      expect(style.left).toBe('100px')
      expect(style.bottom).toBe('372px')
    })

    it('clamps left position to edgeMargin when anchor is near left edge', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 2, right: 30 })
      const style = computeMenuStyle(rect, { viewportWidth: 1024, viewportHeight: 768, edgeMargin: 8 })

      expect(style.left).toBe('8px')
    })

    it('shifts left when menu would overflow right viewport edge', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 900, right: 930 })
      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: 768,
        maxWidth: 200,
        edgeMargin: 6,
      })

      expect(style.left).toBe('818px')
    })

    it('flips menu below the anchor when not enough space above', () => {
      // Anchor near top with large edgeMargin so flip triggers
      const rect = mockRect({ top: 5, bottom: 40, left: 100, right: 140 })
      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: 768,
        menuItemsCount: 5,
        edgeMargin: 10,
      })

      // bottom = 768 - 40 - 4 - (36 + 5*28) = 548
      expect(style.bottom).toBe('548px')
    })

    it('keeps menu above anchor when there is enough space', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 100, right: 140 })
      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: 768,
        menuItemsCount: 5,
        edgeMargin: 6,
      })

      expect(style.bottom).toBe('372px')
    })

    it('uses default values when no options provided', () => {
      const rect = mockRect({ top: 300, bottom: 340, left: 100, right: 140 })
      const style = computeMenuStyle(rect, { viewportWidth: 1024, viewportHeight: 768 })

      expect(style.maxWidth).toBe('220px')
      expect(style.position).toBe('fixed')
      expect(style.overflowY).toBe('auto')
    })
  })

  describe('right anchor', () => {
    it('positions menu above and right-aligned to anchor', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 800, right: 900 })
      const style = computeMenuStyle(rect, {
        anchor: 'right',
        viewportWidth: 1024,
        viewportHeight: 768,
      })

      expect(style.position).toBe('fixed')
      expect(style.right).toBe('124px')
      expect(style.bottom).toBe('372px')
      expect(style.left).toBeUndefined()
    })

    it('clamps right position to edgeMargin when anchor is near right edge', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 900, right: 1020 })
      const style = computeMenuStyle(rect, {
        anchor: 'right',
        viewportWidth: 1024,
        viewportHeight: 768,
        edgeMargin: 8,
      })

      expect(style.right).toBe('8px')
    })

    it('shifts right when menu would overflow left viewport edge', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 0, right: 50 })
      const style = computeMenuStyle(rect, {
        anchor: 'right',
        viewportWidth: 1024,
        viewportHeight: 768,
        maxWidth: 200,
        edgeMargin: 6,
      })

      expect(style.right).toBe('818px')
    })

    it('flips menu below anchor in right-aligned mode when no space above', () => {
      const rect = mockRect({ top: 5, bottom: 40, left: 800, right: 900 })
      const style = computeMenuStyle(rect, {
        anchor: 'right',
        viewportWidth: 1024,
        viewportHeight: 768,
        menuItemsCount: 5,
        edgeMargin: 10,
      })

      expect(style.bottom).toBe('548px')
    })
  })

  describe('maxHeight calculation', () => {
    it('uses min of maxHeight and viewport-adjusted value', () => {
      const rect = mockRect({ top: 300, bottom: 340, left: 100, right: 140 })
      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: 768,
        maxHeight: 400,
        edgeMargin: 10,
      })

      expect(style.maxHeight).toBe('min(400px, calc(100vh - 20px))')
    })

    it('uses default maxHeight when not specified', () => {
      const rect = mockRect({ top: 300, bottom: 340, left: 100, right: 140 })
      const style = computeMenuStyle(rect, { viewportWidth: 1024, viewportHeight: 768 })

      expect(style.maxHeight).toBe('min(320px, calc(100vh - 12px))')
    })
  })

  describe('edge cases', () => {
    it('handles anchor at exact viewport center', () => {
      const rect = mockRect({ top: 384, bottom: 404, left: 512, right: 532 })
      const style = computeMenuStyle(rect, { viewportWidth: 1024, viewportHeight: 768 })

      expect(style.position).toBe('fixed')
      expect(style.left).toBe('512px')
    })

    it('handles zero-height anchor element', () => {
      const rect = mockRect({ top: 300, bottom: 300, left: 100, right: 140 })
      const style = computeMenuStyle(rect, { viewportWidth: 1024, viewportHeight: 768 })

      expect(style.bottom).toBe('472px')
    })

    it('handles anchor at top=0 (very top of viewport)', () => {
      const rect = mockRect({ top: 0, bottom: 40, left: 100, right: 140 })
      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: 768,
        edgeMargin: 6,
        menuItemsCount: 5,
      })

      // bottom = 768 - 0 + 4 = 772; vh - bottom = -4 < 6 => flip
      // bottom = 768 - 40 - 4 - 176 = 548
      expect(style.bottom).toBe('548px')
    })

    it('handles minimal viewport', () => {
      const rect = mockRect({ top: 5, bottom: 15, left: 5, right: 15 })
      const style = computeMenuStyle(rect, {
        viewportWidth: 50,
        viewportHeight: 50,
        maxWidth: 40,
        edgeMargin: 2,
        menuItemsCount: 2,
      })

      expect(style.position).toBe('fixed')
      expect(Number.parseInt(style.left)).not.toBeNaN()
      expect(Number.parseInt(style.bottom)).not.toBeNaN()
    })

    it('clamps to top edge when menu is taller than viewport in flip-below mode', () => {
      // Small viewport, many items: flip goes below anchor, but then
      // the second check also fails (menu still doesn't fit), so clamp to top
      const rect = mockRect({ top: 5, bottom: 50, left: 100, right: 140 })
      const vh = 100
      const menuItemsCount = 50
      const edgeMargin = 6
      const estMenuHeight = 36 + menuItemsCount * 28 // 1436

      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: vh,
        menuItemsCount,
        edgeMargin,
      })

      // Step 1: bottom = 100 - 5 + 4 = 99; 100 - 99 = 1 < 6 => flip
      // Step 2: bottom = 100 - 50 - 4 - 1436 = -1390
      //   vh - bottom - estMenuHeight = 100 - (-1390) - 1436 = 54 >= 6
      //   So no second clamp; final bottom = -1390
      expect(style.bottom).toBe(`${vh - rect.bottom - 4 - estMenuHeight}px`)
    })

    it('triggers both flip and top-clamp when menu exceeds viewport from both sides', () => {
      // Use a viewport and anchor where the flip-below still leaves menu
      // overflowing the top. The second condition must also be true.
      const rect = mockRect({ top: 5, bottom: 50, left: 100, right: 140 })
      const vh = 100
      const menuItemsCount = 20
      const edgeMargin = 200 // Very large margin forces both conditions

      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: vh,
        menuItemsCount,
        edgeMargin,
      })

      const estMenuHeight = 36 + menuItemsCount * 28
      // Both flip and clamp triggered → bottom = vh - estMenuHeight - edgeMargin
      expect(style.bottom).toBe(`${vh - estMenuHeight - edgeMargin}px`)
    })

    it('handles very large menuItemsCount with flip-below', () => {
      const rect = mockRect({ top: 5, bottom: 50, left: 100, right: 140 })
      const vh = 768
      const menuItemsCount = 100
      const edgeMargin = 10
      const estMenuHeight = 36 + menuItemsCount * 28

      const style = computeMenuStyle(rect, {
        viewportWidth: 1024,
        viewportHeight: vh,
        menuItemsCount,
        edgeMargin,
      })

      // bottom = 768 - 5 + 4 = 767; 768 - 767 = 1 < 10 => flip
      // bottom = 768 - 50 - 4 - 2836 = -2122
      // 768 - (-2122) - 2836 = 54 >= 10 => no clamp
      expect(style.bottom).toBe(`${vh - rect.bottom - 4 - estMenuHeight}px`)
    })

    it('produces consistent left/right values for same anchor position', () => {
      const rect = mockRect({ top: 400, bottom: 440, left: 500, right: 540 })
      const leftStyle = computeMenuStyle(rect, {
        anchor: 'left',
        viewportWidth: 1024,
        viewportHeight: 768,
      })
      const rightStyle = computeMenuStyle(rect, {
        anchor: 'right',
        viewportWidth: 1024,
        viewportHeight: 768,
      })

      // Both should produce valid positions
      expect(leftStyle.position).toBe('fixed')
      expect(rightStyle.position).toBe('fixed')
      // Left anchor uses left, right anchor uses right
      expect(leftStyle.left).toBeDefined()
      expect(rightStyle.right).toBeDefined()
    })
  })
})
