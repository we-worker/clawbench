import { ref } from 'vue'
import { apiGet, apiPost, apiPut, apiDelete } from '@/utils/api'

/** Base shape every CRUD list item must satisfy */
export interface CrudItem {
  id: number
  label: string
  sort_order?: number
}

export interface UseCrudListOptions {
  /** API endpoint prefix, e.g. '/api/chat/quick-send' */
  apiPrefix: string
  /** Human-readable name used only in error messages */
  itemName?: string
}

type GenericInstance = {
  items: ReturnType<typeof useCrudList>['items']
  loaded: ReturnType<typeof useCrudList>['loaded']
  showEditDialog: ReturnType<typeof useCrudList>['showEditDialog']
  fetchItems: (force?: boolean) => Promise<void>
  addItem: (item: Record<string, unknown>) => Promise<boolean>
  updateItem: (id: number, item: Record<string, unknown>) => Promise<boolean>
  deleteItem: (id: number) => Promise<boolean>
  reorderItems: (ids: number[]) => Promise<boolean>
}

const _singletons = new Map<string, GenericInstance>()

const _items = ref<unknown[]>([])
const _loaded = ref(false)
const _showEditDialog = ref(false)

async function _fetchItems(apiPrefix: string, force = false) {
  if (_loaded.value && !force) return
  try {
    _items.value = (await apiGet<unknown[]>(apiPrefix)) || []
    _loaded.value = true
  } catch {
    // Silently fail on initial load
  }
}

async function _addItem(apiPrefix: string, item: Record<string, unknown>): Promise<boolean> {
  try {
    await apiPost(apiPrefix, item)
    await _fetchItems(apiPrefix, true)
    return true
  } catch {
    return false
  }
}

async function _updateItem(
  apiPrefix: string,
  id: number,
  item: Record<string, unknown>
): Promise<boolean> {
  try {
    await apiPut(`${apiPrefix}/${id}`, item)
    await _fetchItems(apiPrefix, true)
    return true
  } catch {
    return false
  }
}

async function _deleteItem(apiPrefix: string, id: number): Promise<boolean> {
  try {
    await apiDelete(`${apiPrefix}/${id}`)
    await _fetchItems(apiPrefix, true)
    return true
  } catch {
    return false
  }
}

async function _reorderItems(apiPrefix: string, ids: number[]): Promise<boolean> {
  const oldItems = [..._items.value] as Record<string, unknown>[]
  // Optimistic reorder
  const reordered = ids
    .map((id, i) => {
      const item = (_items.value as Record<string, unknown>[]).find(it => it['id'] === id)
      return item ? { ...item, sort_order: i } : null
    })
    .filter(Boolean) as Record<string, unknown>[]
  _items.value = reordered
  try {
    await apiPut(`${apiPrefix}/reorder`, { ids })
    return true
  } catch {
    _items.value = oldItems // Rollback
    return false
  }
}

/**
 * Generic composable that holds all shared CRUD + reorder logic.
 *
 * Uses a singleton map keyed by apiPrefix so all callers share the same
 * module-level refs — no duplicate network requests or state.
 */
export function useCrudList<T extends CrudItem>(options: UseCrudListOptions) {
  const key = options.apiPrefix

  if (!_singletons.has(key)) {
    _singletons.set(key, {
      items: _items as ReturnType<typeof useCrudList>['items'],
      loaded: _loaded,
      showEditDialog: _showEditDialog,
      fetchItems: (force?: boolean) => _fetchItems(key, force),
      addItem: (item: Record<string, unknown>) => _addItem(key, item),
      updateItem: (id: number, item: Record<string, unknown>) => _updateItem(key, id, item),
      deleteItem: (id: number) => _deleteItem(key, id),
      reorderItems: (ids: number[]) => _reorderItems(key, ids),
    })
  }

  return _singletons.get(key)! as {
    items: { value: T[] }
    loaded: typeof _loaded
    showEditDialog: typeof _showEditDialog
    fetchItems: (force?: boolean) => Promise<void>
    addItem: (item: Omit<T, 'id' | 'sort_order'>) => Promise<boolean>
    updateItem: (id: number, item: Partial<T>) => Promise<boolean>
    deleteItem: (id: number) => Promise<boolean>
    reorderItems: (ids: number[]) => Promise<boolean>
  }
}
