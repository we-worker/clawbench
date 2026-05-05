<template>
  <div class="chat-message user pending">
    <FileAttachmentList v-if="hasFiles" :files="allFiles" @file-tag-click="$emit('file-tag-click', $event)" />

    <span v-if="msg.text" class="pending-text">{{ msg.text }}</span>
    <span class="pending-hint">
      <span class="pending-spinner"></span>
      {{ t('chat.pending.queuing') }}
      <button class="pending-remove" @click="$emit('remove', index)" :title="t('common.remove')">×</button>
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import FileAttachmentList from './FileAttachmentList.vue'

const { t } = useI18n()

const props = defineProps({
  msg: Object,
  index: Number,
})
defineEmits(['remove', 'file-tag-click'])

// Merge files from both msg.files (upload paths) and msg.filePaths (reference paths)
const allFiles = computed(() => {
  const files = []
  if (props.msg?.files?.length) files.push(...props.msg.files)
  if (props.msg?.filePaths?.length) {
    for (const p of props.msg.filePaths) {
      // Avoid duplicates if same path appears in both
      if (!files.includes(p)) files.push(p)
    }
  }
  return files
})

const hasFiles = computed(() => allFiles.value.length > 0)
</script>

<style scoped>
/* Reuse .chat-message.user styles — only override transparency and dashed border */
.chat-message.user.pending {
  opacity: 0.55;
  border: 1px dashed rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  animation: pending-fade-in 0.25s ease-out;
}

.pending-text {
  color: inherit;
  word-break: break-word;
  white-space: pre-wrap;
}

.pending-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.6);
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  transition: color 0.15s;
}

.pending-remove:hover {
  color: rgba(255, 255, 255, 1);
}

.pending-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.7);
  flex-basis: 100%;
}

.pending-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid rgba(255, 255, 255, 0.3);
  border-top-color: rgba(255, 255, 255, 0.8);
  border-radius: 50%;
  animation: pending-spin 0.6s linear infinite;
}

@keyframes pending-spin {
  to { transform: rotate(360deg); }
}

@keyframes pending-fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 0.55; transform: translateY(0); }
}
</style>
