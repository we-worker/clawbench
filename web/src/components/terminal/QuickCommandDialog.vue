<template>
  <ModalDialog :open="open" :title="currentPage === 'list' ? t('terminal.quickCommands') : (editingCommand ? t('terminal.editCommand') : t('terminal.addCommand'))" @close="handleClose">
    <template #header>
      <span class="modal-header-icon" @click="goBackIfEdit">
        <ChevronLeftIcon v-if="currentPage === 'edit'" :size="16" />
        <ZapIcon v-else :size="16" />
      </span>
      <span class="modal-title">{{ currentPage === 'list' ? t('terminal.quickCommands') : (editingCommand ? t('terminal.editCommand') : t('terminal.addCommand')) }}</span>
    </template>

    <!-- Page: Command list -->
    <div v-if="currentPage === 'list'" class="qc-content">
      <div v-if="commands.length > 0" class="qc-list">
        <draggable
          v-model="localCommands"
          handle=".drag-handle"
          item-key="id"
          @end="onDragEnd"
        >
          <template #item="{ element: cmd }">
            <div class="qc-item-wrapper">
              <div class="qc-row" :class="{ 'qc-hidden': cmd.hidden }">
                <span class="drag-handle">≡</span>
                <span class="qc-label">
                  <ZapIcon v-if="cmd.auto_execute" :size="12" class="qc-badge-auto" />
                  <EyeOffIcon v-if="cmd.hidden" :size="12" class="qc-badge-dim" />
                  {{ cmd.label }}
                </span>
                <span class="qc-cmd" :title="cmd.command">{{ cmd.command }}</span>
                <button class="qc-action" @click="editCommand(cmd)" :title="t('terminal.editCommand')">
                  <PencilIcon :size="14" />
                </button>
                <button class="qc-action danger" @click="toggleDeleteConfirm(cmd.id)" :title="t('terminal.deleteCommand')">
                  <Trash2Icon :size="14" />
                </button>
              </div>
              <!-- Inline delete confirmation -->
              <div v-if="deleteConfirmId === cmd.id" class="qc-delete-confirm">
                <span>{{ t('terminal.deleteConfirm') }}</span>
                <button class="qc-confirm-btn delete" @click="doDelete(cmd.id)">{{ t('common.confirm') }}</button>
                <button class="qc-confirm-btn cancel" @click="deleteConfirmId = null">{{ t('common.cancel') }}</button>
              </div>
            </div>
          </template>
        </draggable>
      </div>
      <div v-else class="qc-empty">
        {{ t('terminal.addCommand') }}
      </div>

      <button class="qc-add" @click="addNewCommand">
        <PlusIcon :size="16" />
        {{ t('terminal.addCommand') }}
      </button>
    </div>

    <!-- Page: Edit form (drill-down) -->
    <div v-else class="qc-edit-content">
      <div class="form-group">
        <label class="form-label">{{ t('terminal.commandLabel') }} <span class="required">*</span></label>
        <input type="text" class="form-input" v-model="form.label" :placeholder="t('terminal.commandLabel')" />
      </div>
      <div class="form-group">
        <label class="form-label">{{ t('terminal.commandText') }} <span class="required">*</span></label>
        <input type="text" class="form-input" v-model="form.command" :placeholder="t('terminal.commandText')" />
      </div>
      <div v-if="formError" class="form-error">{{ formError }}</div>

      <label class="form-checkbox">
        <input type="checkbox" v-model="form.hidden" />
        <span>{{ t('terminal.commandHidden') }}</span>
      </label>
      <label class="form-checkbox">
        <input type="checkbox" v-model="form.auto_execute" />
        <span>{{ t('terminal.commandAutoExecute') }}</span>
      </label>
      <div v-if="form.auto_execute && hasExistingAutoExec" class="form-hint">{{ t('terminal.autoExecuteWarning') }}</div>
    </div>

    <template #footer>
      <template v-if="currentPage === 'list'">
        <button class="modal-btn" @click="$emit('close')">{{ t('common.close') }}</button>
      </template>
      <template v-else>
        <button class="modal-btn" @click="currentPage = 'list'">{{ t('common.cancel') }}</button>
        <button class="modal-btn primary" :disabled="saving" @click="saveCommand">{{ saving ? '...' : t('common.save') }}</button>
      </template>
    </template>
  </ModalDialog>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import draggable from 'vuedraggable'
import ModalDialog from '@/components/common/ModalDialog.vue'
import { ZapIcon, PencilIcon, Trash2Icon, PlusIcon, ChevronLeftIcon, EyeOffIcon } from 'lucide-vue-next'
import { useQuickCommands, type QuickCommand } from '@/composables/useQuickCommands'
import { useToast } from '@/composables/useToast'

const props = defineProps({
  open: Boolean,
})

const emit = defineEmits(['close'])

const { t } = useI18n()
const toast = useToast()
const { commands, reorderCommands, addCommand, updateCommand, deleteCommand } = useQuickCommands()

const localCommands = ref<QuickCommand[]>([...commands.value])
const currentPage = ref<'list' | 'edit'>('list')
const editingCommand = ref<QuickCommand | null>(null)
const form = ref({ label: '', command: '', hidden: false, auto_execute: false })
const formError = ref('')
const saving = ref(false)
const deleteConfirmId = ref<number | null>(null)

// Whether another command already has auto_execute (for warning)
const hasExistingAutoExec = computed(() => {
  if (!editingCommand.value) {
    return commands.value.some(c => c.auto_execute)
  }
  return commands.value.some(c => c.auto_execute && c.id !== editingCommand.value!.id)
})

// Sync local list when commands change
watch(commands, (val) => {
  localCommands.value = [...val]
}, { deep: true })

// Reset state when dialog opens/closes
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    currentPage.value = 'list'
    deleteConfirmId.value = null
    formError.value = ''
    editingCommand.value = null
  }
})

function handleClose() {
  currentPage.value = 'list'
  deleteConfirmId.value = null
  emit('close')
}

function goBackIfEdit() {
  if (currentPage.value === 'edit') {
    currentPage.value = 'list'
  }
}

function editCommand(cmd: QuickCommand) {
  editingCommand.value = cmd
  form.value = { label: cmd.label, command: cmd.command, hidden: cmd.hidden, auto_execute: cmd.auto_execute }
  formError.value = ''
  currentPage.value = 'edit'
}

function addNewCommand() {
  editingCommand.value = null
  form.value = { label: '', command: '', hidden: false, auto_execute: false }
  formError.value = ''
  currentPage.value = 'edit'
}

async function saveCommand() {
  const label = form.value.label.trim()
  const command = form.value.command.trim()
  if (!label || !command) {
    formError.value = t('terminal.commandRequired')
    return
  }
  formError.value = ''
  saving.value = true

  try {
    let ok: boolean
    if (editingCommand.value) {
      ok = await updateCommand(editingCommand.value.id, { label, command, hidden: form.value.hidden, auto_execute: form.value.auto_execute })
    } else {
      ok = await addCommand({ label, command, hidden: form.value.hidden, auto_execute: form.value.auto_execute })
    }

    if (ok) {
      toast.show(t('terminal.commandSaved'), { type: 'success' })
      currentPage.value = 'list'
    } else {
      formError.value = t('terminal.saveFailed')
    }
  } finally {
    saving.value = false
  }
}

function toggleDeleteConfirm(id: number) {
  deleteConfirmId.value = deleteConfirmId.value === id ? null : id
}

async function doDelete(id: number) {
  deleteConfirmId.value = null
  const ok = await deleteCommand(id)
  if (ok) {
    toast.show(t('terminal.commandDeleted'), { type: 'success' })
  }
}

async function onDragEnd() {
  const ids = localCommands.value.map(c => c.id)
  const ok = await reorderCommands(ids)
  if (!ok) {
    toast.show(t('terminal.reorderFailed'), { type: 'error' })
    localCommands.value = [...commands.value] // Reset from source of truth
  }
}
</script>

<style>
.qc-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.qc-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.qc-item-wrapper {
  border-bottom: 1px solid var(--border-color, #e5e5e5);
}

.qc-item-wrapper:last-child {
  border-bottom: none;
}

.qc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary);
  transition: background 0.12s;
}

.qc-row.qc-hidden {
  opacity: 0.55;
}

.qc-row:hover {
  background: var(--bg-tertiary, #f5f5f5);
}

.drag-handle {
  cursor: grab;
  color: var(--text-muted, #999);
  font-size: 16px;
  line-height: 1;
  user-select: none;
  padding: 0 2px;
}

.drag-handle:active {
  cursor: grabbing;
}

.qc-label {
  flex-shrink: 0;
  font-weight: 500;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 3px;
}

.qc-badge-auto {
  color: var(--accent-color, #0066cc);
  flex-shrink: 0;
}

.qc-badge-dim {
  color: var(--text-muted, #999);
  flex-shrink: 0;
}

.qc-cmd {
  flex: 1;
  min-width: 0;
  color: var(--text-muted, #999);
  font-family: monospace;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qc-action {
  background: none;
  border: none;
  color: var(--text-muted, #999);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  border-radius: 4px;
  transition: background 0.12s, color 0.12s;
}

.qc-action:hover {
  background: var(--bg-tertiary, #f0f0f0);
  color: var(--text-primary);
}

.qc-action.danger:hover {
  color: #e53e3e;
}

.qc-delete-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 28px;
  background: color-mix(in srgb, #e53e3e 8%, transparent);
  font-size: 12px;
  color: var(--text-secondary, #666);
}

.qc-confirm-btn {
  padding: 3px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  background: var(--bg-primary, #fff);
  color: var(--text-primary);
}

.qc-confirm-btn.delete {
  background: #e53e3e;
  color: #fff;
  border-color: #e53e3e;
}

.qc-confirm-btn.cancel {
  color: var(--text-muted, #999);
}

.qc-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted, #999);
  font-size: 13px;
}

.qc-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  margin: 4px 10px 10px;
  border: 1px dashed var(--border-color, #ddd);
  border-radius: 8px;
  background: none;
  color: var(--accent-color, #0066cc);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s;
}

.qc-add:hover {
  background: color-mix(in srgb, var(--accent-color, #0066cc) 8%, transparent);
}

.qc-edit-content {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary, #666);
}

.form-label .required {
  color: #e53e3e;
}

.form-input {
  padding: 8px 10px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus {
  border-color: var(--accent-color, #0066cc);
}

.form-error {
  font-size: 12px;
  color: #e53e3e;
}

.form-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

.form-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-color, #0066cc);
}

.form-hint {
  font-size: 11px;
  color: var(--text-muted, #999);
  padding-left: 24px;
}

.modal-btn {
  padding: 6px 16px;
  border: 1px solid var(--border-color, #ddd);
  border-radius: 6px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s;
}

.modal-btn:hover {
  background: var(--bg-tertiary, #f5f5f5);
}

.modal-btn.primary {
  background: var(--accent-color, #0066cc);
  color: #fff;
  border-color: var(--accent-color, #0066cc);
}

.modal-btn.primary:hover {
  opacity: 0.9;
}

.modal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
