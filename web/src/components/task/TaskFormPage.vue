<template>
  <div class="task-form-page">
    <!-- Compact header: breadcrumb -->
    <div class="form-header">
      <TaskBreadcrumb />
    </div>

    <!-- Scrollable form content -->
    <div class="form-scroll">
      <div v-if="saving" class="saving-indicator">{{ t('task.form.saving') }}</div>

      <!-- Task name -->
      <div class="form-group">
        <label class="form-label">{{ t('task.form.taskName') }} <span class="required">*</span></label>
        <input type="text" class="form-input" v-model="form.name" :placeholder="t('task.form.taskNamePlaceholder')" />
        <div v-if="errors.name" class="form-error">{{ errors.name }}</div>
      </div>

      <!-- Frequency preset -->
      <div class="form-group">
        <label class="form-label">{{ t('task.form.frequency') }}</label>
        <div class="preset-buttons">
          <button v-for="p in presets" :key="p.value" class="preset-btn" :class="{ active: preset === p.value }" @click="setPreset(p.value)">
            {{ p.label }}
          </button>
          <button class="preset-btn" :class="{ active: preset === 'custom' }" @click="setPreset('custom')">
            {{ t('task.form.custom') }}
          </button>
        </div>
      </div>

      <!-- Time selectors based on preset -->
      <div v-if="preset !== 'custom'" class="form-group time-selectors">
        <!-- Hourly: minute only -->
        <div v-if="preset === 'hourly'" class="time-row">
          <span class="time-label">{{ t('task.form.minute') }}</span>
          <select class="form-select time-select" v-model.number="minute">
            <option v-for="m in 60" :key="m - 1" :value="m - 1">{{ String(m - 1).padStart(2, '0') }}</option>
          </select>
        </div>

        <!-- Daily: hour + minute -->
        <div v-if="preset === 'daily'" class="time-row">
          <select class="form-select time-select" v-model.number="hour">
            <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}</option>
          </select>
          <span class="time-sep">:</span>
          <select class="form-select time-select" v-model.number="minute">
            <option v-for="m in 12" :key="(m - 1) * 5" :value="(m - 1) * 5">{{ String((m - 1) * 5).padStart(2, '0') }}</option>
          </select>
        </div>

        <!-- Weekly: weekday + hour + minute -->
        <div v-if="preset === 'weekly'" class="time-column">
          <div class="weekday-buttons">
            <button v-for="(label, idx) in weekdayLabels" :key="idx" class="weekday-btn" :class="{ active: weekday === idx }" @click="weekday = idx">
              {{ label }}
            </button>
          </div>
          <div class="time-row">
            <select class="form-select time-select" v-model.number="hour">
              <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}</option>
            </select>
            <span class="time-sep">:</span>
            <select class="form-select time-select" v-model.number="minute">
              <option v-for="m in 12" :key="(m - 1) * 5" :value="(m - 1) * 5">{{ String((m - 1) * 5).padStart(2, '0') }}</option>
            </select>
          </div>
        </div>

        <!-- Monthly: month day + hour + minute -->
        <div v-if="preset === 'monthly'" class="time-column">
          <div class="time-row">
            <span class="time-label">{{ t('task.form.date') }}</span>
            <select class="form-select time-select" v-model.number="monthDay">
              <option v-for="d in 31" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <div v-if="monthDay >= 29" class="form-hint warning">{{ t('task.form.monthDaySkipHint') }}</div>
          <div class="time-row">
            <select class="form-select time-select" v-model.number="hour">
              <option v-for="h in 24" :key="h - 1" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}</option>
            </select>
            <span class="time-sep">:</span>
            <select class="form-select time-select" v-model.number="minute">
              <option v-for="m in 12" :key="(m - 1) * 5" :value="(m - 1) * 5">{{ String((m - 1) * 5).padStart(2, '0') }}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Generated cron expression -->
      <div class="form-group">
        <label class="form-label">{{ t('task.form.cronExpression') }}</label>
        <input
          v-if="preset === 'custom'"
          type="text"
          class="form-input"
          v-model="customCron"
          placeholder="0 9 * * *"
        />
        <div v-else class="cron-display">
          <code>{{ generatedCron }}</code>
          <span class="cron-humanize">{{ humanizeCron(generatedCron) }}</span>
        </div>
        <div v-if="preset === 'custom'" class="form-hint">{{ t('task.form.cronHint') }}</div>
        <div v-if="errors.cronExpr" class="form-error">{{ errors.cronExpr }}</div>
      </div>

      <!-- Agent -->
      <div class="form-group">
        <label class="form-label">{{ t('task.form.executeAgent') }} <span class="required">*</span></label>
        <select class="form-select" v-model="form.agentId">
          <option value="" disabled>{{ t('task.form.selectAgent') }}</option>
          <option v-for="agent in agents" :key="agent.id" :value="agent.id">
            {{ agent.icon }} {{ agent.name }}
          </option>
        </select>
        <div v-if="errors.agentId" class="form-error">{{ errors.agentId }}</div>
      </div>

      <!-- Repeat mode -->
      <div class="form-group">
        <label class="form-label">{{ t('task.form.repeatMode') }}</label>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" v-model="form.repeatMode" value="once" />
            <span>{{ t('task.form.repeatOnce') }}</span>
          </label>
          <label class="radio-label">
            <input type="radio" v-model="form.repeatMode" value="limited" />
            <span>{{ t('task.form.repeatLimited') }}</span>
          </label>
          <label class="radio-label">
            <input type="radio" v-model="form.repeatMode" value="unlimited" />
            <span>{{ t('task.form.repeatUnlimited') }}</span>
          </label>
        </div>
      </div>

      <!-- Max runs (limited mode) -->
      <div v-if="form.repeatMode === 'limited'" class="form-group">
        <label class="form-label">{{ t('task.form.maxRuns') }}</label>
        <input type="number" class="form-input" v-model.number="form.maxRuns" min="1" />
      </div>

      <!-- Prompt -->
      <div class="form-group">
        <label class="form-label">{{ t('task.form.prompt') }} <span class="required">*</span></label>
        <textarea class="form-textarea prompt-textarea" v-model="form.prompt" :placeholder="t('task.form.promptPlaceholder')"></textarea>
        <div v-if="errors.prompt" class="form-error">{{ errors.prompt }}</div>
      </div>
    </div>

    <!-- Fixed bottom bar -->
    <div class="form-footer">
      <button class="footer-btn primary" :disabled="saving" @click="submit">
        {{ mode === 'create' ? t('task.form.create') : t('task.form.save') }}
      </button>
      <button class="footer-btn secondary" @click="$emit('close')">{{ t('common.cancel') }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import TaskBreadcrumb from '@/components/task/TaskBreadcrumb.vue'
import { useAgents } from '@/composables/useAgents.ts'
import { humanizeCron } from '@/utils/format.ts'

const { t } = useI18n()

const props = defineProps({
  mode: { type: String, default: 'create' },  // 'create' | 'edit'
  task: Object,  // required for edit mode
})

const emit = defineEmits(['close', 'saved'])

const saving = ref(false)
const { agents, loadAgents } = useAgents()

// Frequency preset
const presets = computed(() => [
  { value: 'hourly', label: t('task.form.presets.hourly') },
  { value: 'daily', label: t('task.form.presets.daily') },
  { value: 'weekly', label: t('task.form.presets.weekly') },
  { value: 'monthly', label: t('task.form.presets.monthly') },
])

const weekdayLabels = computed(() => t('task.form.weekdays'))

const preset = ref('daily')
const minute = ref(0)
const hour = ref(9)
const weekday = ref(1)     // 0=Sun, 1=Mon, ..., 6=Sat
const monthDay = ref(1)
const customCron = ref('')

// Form data
const form = ref({
  id: '',
  name: '',
  cronExpr: '',
  agentId: '',
  prompt: '',
  repeatMode: 'unlimited',
  maxRuns: 0,
})

// Validation errors
const errors = ref({})

// Generate cron from preset
const generatedCron = computed(() => {
  const m = String(minute.value).padStart(2, '0')
  const h = String(hour.value).padStart(2, '0')
  switch (preset.value) {
    case 'hourly':  return `${m} * * * *`
    case 'daily':   return `${m} ${h} * * *`
    case 'weekly':  return `${m} ${h} * * ${weekday.value}`
    case 'monthly': return `${m} ${h} ${monthDay.value} * *`
    default:        return customCron.value
  }
})

// Effective cron expression (for submission)
const effectiveCron = computed(() => {
  return preset.value === 'custom' ? customCron.value.trim() : generatedCron.value
})

// Set preset with smart defaults
function setPreset(p) {
  if (preset.value !== 'custom' && p === 'custom') {
    // Switching to custom: pre-fill with current generated cron
    customCron.value = generatedCron.value
  }
  preset.value = p
}

// Detect preset from existing cron expression (for edit mode)
function detectPreset(cron) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'custom'

  const [m, h, dom, mon, dow] = parts
  const isNumeric = (s) => /^\d+$/.test(s)

  // Hourly: M * * * * (M must be numeric, not step like */5)
  if (isNumeric(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    minute.value = parseInt(m)
    return 'hourly'
  }
  // Daily: M H * * *
  if (isNumeric(m) && isNumeric(h) && dom === '*' && mon === '*' && dow === '*') {
    minute.value = parseInt(m)
    hour.value = parseInt(h)
    return 'daily'
  }
  // Weekly: M H * * DOW
  if (isNumeric(m) && isNumeric(h) && dom === '*' && mon === '*' && isNumeric(dow)) {
    minute.value = parseInt(m)
    hour.value = parseInt(h)
    weekday.value = parseInt(dow)
    return 'weekly'
  }
  // Monthly: M H DOM * *
  if (isNumeric(m) && isNumeric(h) && isNumeric(dom) && mon === '*' && dow === '*') {
    minute.value = parseInt(m)
    hour.value = parseInt(h)
    monthDay.value = parseInt(dom)
    return 'monthly'
  }

  customCron.value = cron
  return 'custom'
}

// Validate form
function validate() {
  const e = {}
  if (!form.value.name.trim()) e.name = t('task.form.nameRequired')
  if (!form.value.agentId) e.agentId = t('task.form.agentRequired')
  if (!form.value.prompt.trim()) e.prompt = t('task.form.promptRequired')
  if (preset.value === 'custom' && !customCron.value.trim()) {
    e.cronExpr = t('task.form.cronRequired')
  }
  errors.value = e
  return Object.keys(e).length === 0
}

// Submit
async function submit() {
  if (!validate()) return
  if (saving.value) return
  saving.value = true

  const payload = {
    name: form.value.name,
    cron_expr: effectiveCron.value,
    agent_id: form.value.agentId,
    prompt: form.value.prompt,
    repeat_mode: form.value.repeatMode,
    max_runs: form.value.maxRuns,
  }

  try {
    let resp
    if (props.mode === 'create') {
      resp = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } else {
      resp = await fetch(`/api/tasks/${form.value.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    if (!resp.ok) {
      const err = await resp.json()
      errors.value = { cronExpr: err.error || t('task.form.operationFailed') }
      return
    }

    const result = await resp.json()
    emit('saved', result.task?.id)
  } catch (err) {
    errors.value = { cronExpr: err.message || t('common.networkError') }
  } finally {
    saving.value = false
  }
}

// Initialize form on mount
onMounted(() => {
  errors.value = {}

  if (props.mode === 'edit' && props.task) {
    form.value = {
      id: props.task.id,
      name: props.task.name,
      cronExpr: props.task.cronExpr,
      agentId: props.task.agentId,
      prompt: props.task.prompt,
      repeatMode: props.task.repeatMode || 'unlimited',
      maxRuns: props.task.maxRuns || 0,
    }
    preset.value = detectPreset(props.task.cronExpr)
  } else {
    // Create mode: reset form
    form.value = {
      id: '',
      name: '',
      cronExpr: '',
      agentId: '',
      prompt: '',
      repeatMode: 'unlimited',
      maxRuns: 0,
    }
    preset.value = 'daily'
    const now = new Date()
    hour.value = now.getHours()
    minute.value = 0
    weekday.value = 1
    monthDay.value = 1
    customCron.value = ''
  }

  if (agents.value.length === 0) {
    loadAgents()
  }
})
</script>

<style scoped>
.task-form-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Compact header */
.form-header {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  flex-shrink: 0;
}

/* Scrollable form content */
.form-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
}

.saving-indicator {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  text-align: center;
  margin-bottom: 8px;
}

.form-group {
  margin-bottom: 10px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary, #1a1a1a);
  margin-bottom: 3px;
}

.required {
  color: #dc3545;
}

.form-input,
.form-select,
.form-textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 4px;
  font-size: 13px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1a1a1a);
  box-sizing: border-box;
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  border-color: var(--accent-color, #0066cc);
}

.form-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}

.form-hint {
  font-size: 11px;
  color: var(--text-muted, #999);
  margin-top: 2px;
}

.form-hint.warning {
  color: #eab308;
}

.form-error {
  font-size: 11px;
  color: #dc3545;
  margin-top: 2px;
}

/* Prompt textarea */
.prompt-textarea {
  height: 40vh;
  min-height: 120px;
  resize: vertical;
}

/* Preset buttons */
.preset-buttons {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.preset-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 4px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1a1a1a);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.preset-btn:hover {
  border-color: var(--accent-color, #0066cc);
  color: var(--accent-color, #0066cc);
}

.preset-btn.active {
  background: var(--accent-color, #0066cc);
  color: #fff;
  border-color: var(--accent-color, #0066cc);
}

/* Time selectors */
.time-selectors {
  background: var(--bg-tertiary, #f9f9f9);
  border-radius: 6px;
  padding: 8px 10px;
}

.time-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.time-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.time-label {
  font-size: 12px;
  color: var(--text-secondary, #666);
  flex-shrink: 0;
}

.time-select {
  width: auto;
  min-width: 52px;
}

.time-sep {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary, #666);
}

/* Weekday buttons */
.weekday-buttons {
  display: flex;
  gap: 4px;
}

.weekday-btn {
  width: 32px;
  height: 28px;
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 4px;
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #1a1a1a);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.weekday-btn:hover {
  border-color: var(--accent-color, #0066cc);
  color: var(--accent-color, #0066cc);
}

.weekday-btn.active {
  background: var(--accent-color, #0066cc);
  color: #fff;
  border-color: var(--accent-color, #0066cc);
}

/* Cron display */
.cron-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-tertiary, #f5f5f5);
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: 4px;
}

.cron-display code {
  font-size: 13px;
  color: var(--accent-color, #0066cc);
  font-family: 'SF Mono', 'Menlo', monospace;
}

.cron-humanize {
  font-size: 11px;
  color: var(--text-muted, #999);
}

/* Radio group */
.radio-group {
  display: flex;
  flex-direction: row;
  gap: 12px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-primary, #1a1a1a);
  cursor: pointer;
}

/* Fixed bottom bar */
.form-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-top: 1px solid var(--border-color, #e5e5e5);
  background: var(--bg-primary, #fff);
  flex-shrink: 0;
}

.footer-btn {
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  display: flex;
  align-items: center;
  gap: 3px;
}

.footer-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.footer-btn.primary {
  background: var(--accent-color, #0066cc);
  color: #fff;
}

.footer-btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.footer-btn.secondary {
  background: var(--bg-tertiary, #f0f0f0);
  color: var(--text-primary, #1a1a1a);
}

.footer-btn.secondary:hover {
  background: #e0e0e0;
}
</style>
