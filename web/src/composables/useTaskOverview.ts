import { ref, type Ref } from 'vue'
import { apiPut, apiDelete } from '@/utils/api.ts'
import { useToast } from '@/composables/useToast.ts'
import { useTaskTab } from '@/composables/useTaskTab.ts'
import { useDialog } from '@/composables/useDialog.ts'
import { gt } from '@/composables/useLocale'

interface UseTaskOverviewOptions {
  task: Ref<any>
  emit: {
    deleted: () => void
    edit: () => void
    history: () => void
  }
}

export function useTaskOverview(options: UseTaskOverviewOptions) {
  const { task, emit } = options
  const toast = useToast()
  const { loadTasks } = useTaskTab()
  const dialog = useDialog()

  const actionLoading = ref(false)

  async function triggerTask(): Promise<void> {
    actionLoading.value = true
    try {
      await apiPut(`/api/tasks/${task.value.id}`, { action: 'trigger' })
      await loadTasks()
    } catch (err: any) {
      toast.show(err?.message || gt('task.actionFailed'), { type: 'error' })
    } finally {
      actionLoading.value = false
    }
  }

  async function pauseTask(): Promise<void> {
    actionLoading.value = true
    try {
      await apiPut(`/api/tasks/${task.value.id}`, { action: 'pause' })
      await loadTasks()
    } catch (err: any) {
      toast.show(err?.message || gt('task.actionFailed'), { type: 'error' })
    } finally {
      actionLoading.value = false
    }
  }

  async function resumeTask(): Promise<void> {
    actionLoading.value = true
    try {
      await apiPut(`/api/tasks/${task.value.id}`, { action: 'resume' })
      await loadTasks()
    } catch (err: any) {
      toast.show(err?.message || gt('task.actionFailed'), { type: 'error' })
    } finally {
      actionLoading.value = false
    }
  }

  async function deleteTask(): Promise<void> {
    if (!await dialog.confirm(gt('task.confirmDelete'), { dangerous: true })) return
    actionLoading.value = true
    try {
      await apiDelete(`/api/tasks/${task.value.id}`)
      await loadTasks()
      emit.deleted()
    } catch (err: any) {
      toast.show(err?.message || gt('task.actionFailed'), { type: 'error' })
    } finally {
      actionLoading.value = false
    }
  }

  return { actionLoading, triggerTask, pauseTask, resumeTask, deleteTask }
}
