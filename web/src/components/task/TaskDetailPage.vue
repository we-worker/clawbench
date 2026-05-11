<template>
  <div class="task-detail-page">
    <!-- Compact header: breadcrumb + sub tabs on same row -->
    <div class="detail-header">
      <TaskBreadcrumb
        currentView="detail"
        :taskName="task?.name"
        :execDetailOpen="false"
        @navigate="onBreadcrumbNavigate"
      />
      <div class="sub-tabs">
        <button class="sub-tab" :class="{ active: subTab === 'overview' }" @click="subTab = 'overview'">{{ t('task.form.tabSettings') }}</button>
        <button class="sub-tab" :class="{ active: subTab === 'history' }" @click="subTab = 'history'">{{ t('task.exec.title') }}</button>
      </div>
    </div>
    <!-- Tab content -->
    <div class="detail-content">
      <TaskOverviewTab v-if="subTab === 'overview'" :task="task" @deleted="$emit('deleted')" @edit="$emit('edit')" />
      <TaskHistoryTab v-else :task="task" @open-file="$emit('open-file', $event)" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import TaskBreadcrumb from '@/components/task/TaskBreadcrumb.vue'
import TaskOverviewTab from '@/components/task/TaskOverviewTab.vue'
import TaskHistoryTab from '@/components/task/TaskHistoryTab.vue'
import { useTaskTab } from '@/composables/useTaskTab'

const { t } = useI18n()
const { detailSubTab, goBack } = useTaskTab()

defineProps<{
  task: any
}>()

defineEmits<{
  back: []
  edit: []
  deleted: []
  'open-file': [filePath: string]
}>()

const subTab = computed({
  get: () => detailSubTab.value,
  set: (val: 'overview' | 'history') => { detailSubTab.value = val },
})

function onBreadcrumbNavigate(view: string) {
  if (view === 'list') {
    goBack()
  }
}
</script>

<style scoped>
.task-detail-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.detail-header {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  gap: 8px;
  flex-shrink: 0;
}

.sub-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-secondary, #f0f0f0);
  border-radius: 6px;
  padding: 2px;
  flex-shrink: 0;
}

.sub-tab {
  padding: 3px 10px;
  border: none;
  background: transparent;
  color: var(--text-muted, #999);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
}

.sub-tab.active {
  background: var(--bg-primary, #fff);
  color: var(--accent-color, #0066cc);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.detail-content {
  flex: 1;
  overflow-y: auto;
}
</style>
