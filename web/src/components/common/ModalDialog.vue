<template>
  <Teleport to="body">
    <div v-show="open" class="modal-overlay" :style="{ zIndex }" @click.self="$emit('close')">
      <div class="modal-dialog" :style="{ maxWidth, maxHeight: maxHeightValue }" @click.stop>
        <div class="modal-header" @click="$emit('close')">
          <span class="modal-title">{{ title }}</span>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-footer">
          <slot name="footer" />
        </div>
        <slot name="after" />
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  open: Boolean,
  title: { type: String, default: '' },
  maxWidth: { type: String, default: '600px' },
  fullHeight: Boolean,
  zIndex: { type: Number, default: 2100 },
})

defineEmits(['close'])

const maxHeightValue = computed(() =>
  props.fullHeight ? 'none' : 'calc(100dvh - 64px)'
)
</script>

<style>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 2100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}

.modal-dialog {
  background: var(--bg-secondary, #fff);
  border-radius: var(--radius-md, 10px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  width: 100%;
  max-width: 600px;
  max-height: calc(100dvh - 64px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-dialog[style*="max-height: none"] {
  max-height: none;
  height: calc(100dvh - 48px);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, #e5e5e5);
  flex-shrink: 0;
  cursor: pointer;
}

.modal-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary, #1a1a1a);
}

.modal-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border-color, #e5e5e5);
  flex-shrink: 0;
  justify-content: flex-end;
}
</style>
