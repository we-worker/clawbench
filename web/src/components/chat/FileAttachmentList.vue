<template>
  <div v-if="files.length > 0" class="chat-files">
    <template v-for="(f, idx) in files" :key="idx">
      <span v-if="isUploadPath(normalizeFileEntry(f).path)" class="chat-file-attachment attachment-upload" @click="$emit('file-tag-click', normalizeFileEntry(f).path)" :title="t('chat.attach.openFile')">
        <FileImage v-if="isImageFile(normalizeFileEntry(f).path)" :size="12" :stroke-width="1.5" />
        <FileText v-else :size="12" :stroke-width="1.5" />
        <span class="chat-file-name">{{ getFileName(normalizeFileEntry(f).path) }}</span>
      </span>
      <span v-else class="chat-file-attachment attachment-ref" @click="$emit('file-tag-click', normalizeFileEntry(f).path)" :title="t('chat.attach.openFile')">
        <Paperclip :size="12" :stroke-width="1.5" />
        <span class="chat-file-name">{{ getFileName(normalizeFileEntry(f).path) }}</span>
      </span>
    </template>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { FileImage, FileText, Paperclip } from 'lucide-vue-next'
import { baseName } from '@/utils/path.ts'

const { t } = useI18n()

defineProps({
  files: { type: Array, required: true },
})
defineEmits(['file-tag-click'])

function normalizeFileEntry(f) {
  if (typeof f === 'string') return { path: f }
  return { path: f.path || '' }
}

function isUploadPath(path) {
  return path.startsWith('.clawbench/uploads/') || path.startsWith('.clawbench\\uploads\\')
}

function isImageFile(path) {
  if (!path) return false
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif', '.avif']
  const lower = path.toLowerCase()
  return imageExts.some(ext => lower.endsWith(ext))
}

function getFileName(path) {
  return baseName(path)
}
</script>
