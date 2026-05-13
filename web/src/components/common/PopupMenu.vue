<template>
  <Teleport to="body">
    <Transition name="menu-fade">
      <div v-if="show" class="popup-menu" role="menu" :style="menuStyle" @click.stop="emit('update:show', false)" @keydown.escape="emit('update:show', false)">
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, watch, onBeforeUnmount } from 'vue'
import { computeMenuStyle } from '@/utils/popupMenuPosition'

const props = defineProps({
  show: Boolean,
  targetElement: { type: Object }, // DOM element reference
  anchor: { type: String, default: 'left' }, // 'left' | 'right'
  maxWidth: { type: Number, default: 220 },
  maxHeight: { type: Number, default: 320 },
  edgeMargin: { type: Number, default: 6 },
  menuItemsCount: { type: Number, default: 10 }, // for height estimation
})

const emit = defineEmits(['update:show'])

// Menu style (reactive to targetElement and viewport)
const menuStyle = computed(() => {
  if (!props.targetElement) return {}
  const rect = props.targetElement.getBoundingClientRect()
  return computeMenuStyle(rect, {
    anchor: props.anchor,
    maxWidth: props.maxWidth,
    maxHeight: props.maxHeight,
    edgeMargin: props.edgeMargin,
    menuItemsCount: props.menuItemsCount,
  })
})

// Close on outside click
function handleClickOutside(e) {
  if (!props.targetElement) return
  if (props.targetElement.contains(e.target)) return
  if (e.target.closest('.popup-menu')) return
  emit('update:show', false)
}

watch(() => props.show, (val) => {
  if (val) {
    // Use setTimeout to avoid the opening click being treated as outside click
    setTimeout(() => {
      if (props.show) {
        document.addEventListener('click', handleClickOutside)
      }
    }, 0)
  } else {
    document.removeEventListener('click', handleClickOutside)
  }
})

// Cleanup on unmount
onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.popup-menu {
  background: var(--bg-secondary, #fff);
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 8px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.12);
  z-index: 9999;
  padding: 3px 0;
}

/* Fade animation for menu appearance */
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
