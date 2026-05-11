<template>
  <div class="task-breadcrumb">
    <!-- Root crumb: 任务列表 -->
    <span
      class="task-crumb"
      :class="{ current: isList, clickable: !isList }"
      @click="!isList && navigate('list')"
    >{{ t('task.title') }}</span>

    <!-- Task name crumb -->
    <template v-if="taskName">
      <span class="task-crumb-sep">›</span>
      <span
        class="task-crumb"
        :class="{ current: isSettings, clickable: !isSettings }"
        @click="!isSettings && navigate('settings')"
      >{{ taskName }}</span>
    </template>

    <!-- History crumb -->
    <template v-if="showHistoryCrumb">
      <span class="task-crumb-sep">›</span>
      <span
        class="task-crumb"
        :class="{ current: isHistory, clickable: !isHistory }"
        @click="!isHistory && navigate('history')"
      >{{ t('task.exec.title') }}</span>
    </template>

    <!-- Exec detail crumb -->
    <template v-if="execDetailOpen">
      <span class="task-crumb-sep">›</span>
      <span class="task-crumb current">{{ t('task.exec.detail') }}</span>
    </template>

    <!-- Form crumb -->
    <template v-if="formViewOpen">
      <span class="task-crumb-sep">›</span>
      <span class="task-crumb current">{{ formMode === 'create' ? t('task.form.createTitle') : t('task.form.editTitle') }}</span>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTaskTab } from '@/composables/useTaskTab'
import { store } from '@/stores/app'

const { t } = useI18n()
const { currentView, selectedTaskId, execDetailOpen, formViewOpen, formMode, navigateToList, navigateToTaskSettings, navigateToTaskHistory } = useTaskTab()

// Derive task name from store (same pattern as TaskTab)
const taskName = computed(() => {
  if (!selectedTaskId.value) return null
  return (store.state.tasks || []).find(t => t.id === selectedTaskId.value)?.name || null
})

// Derived state
const isList = computed(() => currentView.value === 'list' && !formViewOpen.value)
const isSettings = computed(() => currentView.value === 'settings' && !execDetailOpen.value && !formViewOpen.value)
const isHistory = computed(() => currentView.value === 'history' && !execDetailOpen.value && !formViewOpen.value)

const showHistoryCrumb = computed(() => {
  // Show when on history page or when exec detail is open (from history)
  if (formViewOpen.value) return false
  return currentView.value === 'history'
})

// Centralized navigation — no more per-page handlers
function navigate(target) {
  if (target === 'list') {
    navigateToList()
  } else if (target === 'settings') {
    const tid = selectedTaskId.value
    if (tid) navigateToTaskSettings(tid)
  } else if (target === 'history') {
    const tid = selectedTaskId.value
    if (tid) navigateToTaskHistory(tid)
  }
}
</script>

<style scoped>
.task-breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  font-size: 12px;
  color: var(--text-muted, #999);
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
}

.task-breadcrumb::-webkit-scrollbar {
  display: none;
}

.task-crumb {
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.task-crumb.clickable {
  cursor: pointer;
}

.task-crumb.clickable:hover {
  background: var(--bg-secondary, #e0e0e0);
  color: var(--accent-color, #4a90d9);
}

.task-crumb.current {
  font-weight: 600;
  color: var(--text-primary, #1a1a1a);
  cursor: default;
}

.task-crumb.current:hover {
  background: none;
  color: var(--text-primary, #1a1a1a);
}

.task-crumb-sep {
  color: var(--text-muted, #999);
  font-size: 10px;
}
</style>
