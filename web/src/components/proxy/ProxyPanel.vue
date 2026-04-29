<template>
  <BottomSheet ref="bottomSheetRef" :open="open" compact title="端口转发" @close="$emit('close')">
    <template #header>
      <svg class="bs-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
      <span class="bs-header-title">端口转发</span>
    </template>

    <div class="proxy-panel">
      <!-- Loading -->
      <div v-if="loading" class="proxy-loading">加载中...</div>

      <!-- Port list -->
      <div v-else-if="ports.length > 0" class="proxy-list">
        <ProxyPortItem
          v-for="p in ports"
          :key="p.port"
          :port="p.port"
          :name="p.name"
          :active="p.active"
          @open="openPort"
          @remove="handleRemove"
        />
      </div>

      <!-- Empty state -->
      <div v-else class="proxy-empty">
        <div class="proxy-empty-text">暂无转发端口</div>
        <div class="proxy-empty-hint">添加服务器上的端口，即可在 WebView 中访问</div>
      </div>

      <!-- Add port form -->
      <div class="proxy-add">
        <div v-if="showAddForm" class="proxy-add-form">
          <input
            ref="portInputRef"
            v-model="newPort"
            type="number"
            class="proxy-add-input"
            placeholder="端口号"
            min="1"
            max="65535"
            @keydown.enter="handleAdd"
          />
          <input
            v-model="newName"
            type="text"
            class="proxy-add-input name-input"
            placeholder="名称（可选）"
            @keydown.enter="handleAdd"
          />
          <button class="proxy-add-confirm" @click="handleAdd" :disabled="!isValidPort">确定</button>
          <button class="proxy-add-cancel" @click="showAddForm = false">取消</button>
        </div>
        <div v-else class="proxy-add-buttons">
          <button class="proxy-add-btn" @click="showAddForm = true; nextTick(() => portInputRef?.focus())">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            添加端口
          </button>
          <button class="proxy-add-btn" @click="handleDetect" :disabled="detecting">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            {{ detecting ? '检测中...' : '自动检测' }}
          </button>
        </div>
      </div>

      <!-- Detected ports (suggestion chips) -->
      <div v-if="detectedPorts.length > 0" class="proxy-detected">
        <div class="proxy-detected-label">检测到的端口：</div>
        <div class="proxy-detected-chips">
          <button
            v-for="p in detectedPortsNotRegistered"
            :key="p"
            class="detect-chip"
            @click="handleQuickAdd(p)"
          >{{ p }}</button>
          <span v-if="detectedPortsNotRegistered.length === 0" class="detect-all-registered">全部已注册</span>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import BottomSheet from '@/components/common/BottomSheet.vue'
import ProxyPortItem from './ProxyPortItem.vue'
import { usePortForward } from '@/composables/usePortForward.ts'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close'])

const bottomSheetRef = ref(null)
const showAddForm = ref(false)
const newPort = ref('')
const newName = ref('')
const detecting = ref(false)
const portInputRef = ref(null)

const { ports, detectedPorts, loading, loadPorts, registerPort, unregisterPort, detectPorts, openPort } = usePortForward()

const isValidPort = computed(() => {
  const p = parseInt(newPort.value)
  return p > 0 && p <= 65535
})

const detectedPortsNotRegistered = computed(() => {
  const registered = new Set(ports.value.map(p => p.port))
  return detectedPorts.value.filter(p => !registered.has(p))
})

async function handleAdd() {
  if (!isValidPort.value) return
  await registerPort(parseInt(newPort.value), newName.value || undefined)
  newPort.value = ''
  newName.value = ''
  showAddForm.value = false
}

async function handleQuickAdd(port) {
  await registerPort(port, '自动检测')
}

async function handleRemove(port) {
  await unregisterPort(port)
}

async function handleDetect() {
  detecting.value = true
  try {
    await detectPorts()
  } finally {
    detecting.value = false
  }
}

watch(() => props.open, async (val) => {
  if (val) {
    await loadPorts()
  }
})
</script>

<style scoped>
.proxy-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px;
}

.proxy-loading,
.proxy-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-muted, #999);
  font-size: 13px;
}

.proxy-empty-hint {
  font-size: 11px;
  margin-top: 4px;
  color: var(--text-muted, #999);
  opacity: 0.7;
}

.proxy-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.proxy-add {
  border-top: 1px solid var(--border-color, #e5e5e5);
  padding-top: 8px;
}

.proxy-add-buttons {
  display: flex;
  gap: 8px;
}

.proxy-add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 1px dashed var(--border-color, #e5e5e5);
  border-radius: 6px;
  background: none;
  color: var(--text-secondary, #666);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.proxy-add-btn:hover {
  border-color: var(--accent-color, #0066cc);
  color: var(--accent-color, #0066cc);
  background: var(--bg-tertiary, #f5f5f5);
}

.proxy-add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.proxy-add-form {
  display: flex;
  gap: 4px;
  align-items: center;
}

.proxy-add-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 4px;
  font-size: 13px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1a1a1a);
  font-family: inherit;
}

.proxy-add-input:focus {
  outline: none;
  border-color: var(--accent-color, #0066cc);
}

.name-input {
  flex: 2;
}

.proxy-add-confirm,
.proxy-add-cancel {
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.proxy-add-confirm {
  background: var(--accent-color, #0066cc);
  color: #fff;
}

.proxy-add-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.proxy-add-cancel {
  background: var(--bg-tertiary, #f0f0f0);
  color: var(--text-secondary, #666);
}

.proxy-detected {
  padding: 4px 0;
}

.proxy-detected-label {
  font-size: 11px;
  color: var(--text-muted, #999);
  margin-bottom: 4px;
}

.proxy-detected-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.detect-chip {
  padding: 3px 8px;
  border: 1px solid var(--accent-color, #0066cc);
  border-radius: 12px;
  background: none;
  color: var(--accent-color, #0066cc);
  font-size: 11px;
  font-family: monospace;
  cursor: pointer;
  transition: all 0.15s;
}

.detect-chip:hover {
  background: var(--accent-color, #0066cc);
  color: #fff;
}

.detect-all-registered {
  font-size: 11px;
  color: var(--text-muted, #999);
  opacity: 0.7;
}
</style>
