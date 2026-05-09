# 终端快捷命令 UI 管理设计

## 背景

终端快捷命令的基础设施已存在：后端 `QuickCommand` 模型、`config.yaml` 解析、`GET /api/terminal/config` API、前端弹出菜单和 `executeCommand()` 执行。但当前只能通过编辑 `config.yaml` 添加命令（改完需重启），没有运行时 UI 管理能力。

本设计为快捷命令增加：运行时增删改、拖动排序、隐藏选项、自动执行选项，以及统一的 UI 交互。

## 目标

- 在弹出菜单底部提供编辑入口，点击打开命令管理对话框
- 对话框支持增删改命令和拖动手柄排序
- 命令支持 `hidden`（不在菜单显示）和 `auto_execute`（打开终端自动执行，全局唯一）
- 数据仅存 SQLite，移除 `config.yaml` 中的 `quick_commands` 配置
- 复用现有 `PopupMenu` 和 `ModalDialog` 组件
- 快捷命令为全局级别，跨项目共享

## 非目标

- 不迁移旧 `config.yaml` 中的命令
- 不支持变量替换或参数输入
- 不支持命令分组/嵌套
- 不做项目级命令（全部全局）

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 持久化方式 | 仅 SQLite | 简单，与 config.yaml 解耦 |
| 旧配置迁移 | 不迁移，直接移除 | 干净利落 |
| 命令作用域 | 全局，跨项目共享 | 用户明确指定，简单 |
| 编辑入口 | 菜单底部编辑按钮 | 用户明确指定 |
| 排序交互 | 拖动手柄（vuedraggable） | 移动端最直觉 |
| 对话框布局 | 列表式一行一命令 | 紧凑，一目了然 |
| 弹出菜单 | 复用 PopupMenu | 与聊天快捷发送风格一致 |
| 对话框 | 复用 ModalDialog | 项目统一组件 |
| 自动执行时机 | 收到 WebSocket status 事件后 | 最可靠，PTY 已就绪 |
| auto_execute 唯一性 | 数据库 partial unique index + 应用层双保险 | 防止任何路径破坏唯一性 |

## 数据库

### 新表

```sql
CREATE TABLE IF NOT EXISTS terminal_quick_commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT NOT NULL,
    command      TEXT NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0,
    auto_execute INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_commands_auto_execute
ON terminal_quick_commands(auto_execute) WHERE auto_execute = 1;
```

注意：
- `auto_execute` 的 partial unique index 保证数据库层只有一个命令的 `auto_execute=1`
- `updated_at` 不会自动更新（SQLite 不支持 `ON UPDATE CURRENT_TIMESTAMP`），`UpdateQuickCommand` 方法必须手动设置 `updated_at = CURRENT_TIMESTAMP`

### Go 结构体（`internal/service/database.go`）

```go
type QuickCommand struct {
    ID         int64  `json:"id"`
    Label      string `json:"label"`
    Command    string `json:"command"`
    Hidden     bool   `json:"hidden"`
    AutoExecute bool  `json:"auto_execute"`
    SortOrder  int    `json:"sort_order"`
}
```

JSON 层使用 `bool`，数据库层使用 `INTEGER`（0/1），CRUD 方法中做转换。

### CRUD 方法（`internal/service/database.go`）

| 方法 | 签名 | 说明 |
|------|------|------|
| GetQuickCommands | `() -> ([]QuickCommand, error)` | 按 sort_order 排序返回全部 |
| AddQuickCommand | `(label, command string, hidden, autoExecute bool) -> (int64, error)` | 新增，若 autoExecute=true 先清除其他命令的 auto_execute。sort_order = MAX(sort_order)+1 |
| UpdateQuickCommand | `(id int64, label, command string, hidden, autoExecute bool) -> error` | 更新，若 autoExecute=true 先清除其他命令的 auto_execute。手动设置 `updated_at = CURRENT_TIMESTAMP` |
| DeleteQuickCommand | `(id int64) -> error` | 删除 |
| ReorderQuickCommands | `(ids []int64) -> error` | 按 IDs 顺序赋值 sort_order = index |

业务规则：
- `auto_execute` 全局唯一——设置新命令为自动执行时，先 `UPDATE SET auto_execute = 0 WHERE auto_execute = 1`，再设置新的。数据库 partial unique index 作为最终安全网
- `hidden=1` 的命令不出现在弹出菜单中，但可在编辑对话框中看到
- `ReorderQuickCommands` 接收 ID 顺序列表，后端自动赋 `sort_order = index`，前端无需计算 sort_order 值
- 输入校验：`label` 1-100 字符 trim 后非空，`command` 1-4096 字符 trim 后非空，不合法返回 `400 Bad Request`

### 移除项

| 文件 | 移除内容 |
|------|---------|
| `internal/model/config.go` | `QuickCommand` 结构体、`TerminalConfig.QuickCommands` 字段 |
| `internal/terminal/manager.go` | `QuickCommand` 结构体、`TerminalConfig.QuickCommands` 字段 |
| `internal/handler/terminal.go` | `TerminalConfigHandler` 中 `quick_commands` 响应字段 |
| `config/config.example.yaml` | `quick_commands` 示例段落 |
| `web/src/i18n/locales/en.ts` | `terminal.noQuickCommands` key（变为死代码） |
| `web/src/i18n/locales/zh.ts` | 对应的 `terminal.noQuickCommands` key |

## API

### 路由注册模式

Go 的 `http.ServeMux` 不支持 `:id` 路径参数。采用与 `scheduler.go` 的 `ServeTaskByID` 相同的模式：注册到 `/api/terminal/quick-commands/`（带尾部斜杠），handler 内用 `strings.TrimPrefix` 提取剩余路径，按 HTTP method 分发。

路由结构：
```
GET    /api/terminal/quick-commands       → 列表
POST   /api/terminal/quick-commands       → 新增
PUT    /api/terminal/quick-commands/reorder → 批量排序
PUT    /api/terminal/quick-commands/{id}   → 更新
DELETE /api/terminal/quick-commands/{id}   → 删除
```

单个 handler `ServeQuickCommands` 处理列表/新增/排序，`ServeQuickCommandByID` 处理单个资源的更新/删除。与 `ServeTasks` / `ServeTaskByID` 模式一致。

### 新端点

| 方法 | 路径 | 用途 | 请求体 | 响应 |
|------|------|------|--------|------|
| GET | `/api/terminal/quick-commands` | 获取全部（按 sort_order） | — | `[{id, label, command, hidden, auto_execute, sort_order}]` |
| POST | `/api/terminal/quick-commands` | 新增 | `{label, command, hidden, auto_execute}` | `{id, label, command, hidden, auto_execute, sort_order}` |
| PUT | `/api/terminal/quick-commands/reorder` | 批量排序 | `{ids: [3, 1, 2]}` | `{success: true}` |
| PUT | `/api/terminal/quick-commands/{id}` | 更新 | `{label, command, hidden, auto_execute}` | `{success: true}` |
| DELETE | `/api/terminal/quick-commands/{id}` | 删除 | — | `{success: true}` |

注意：
- reorder 请求体简化为 `{ids: [3, 1, 2]}`——ID 列表即新顺序，后端赋 `sort_order = index`
- 所有端点使用 `middleware.Auth`
- 这些 handler 不检查 `terminalMgr.IsEnabled()`——快捷命令是数据管理，不依赖终端是否启用
- 需要在 `web/src/utils/api.ts` 中新增 `apiPut` 工具函数（当前只有 `apiGet`/`apiPost`/`apiDelete`）

### 修改现有端点

`GET /api/terminal/config` 响应移除 `quick_commands` 字段，仅返回 `{enabled: true}`。

## 前端

### 组件结构

```
TerminalPanel.vue
  ├── PopupMenu              ← 替换现有 inline popup
  │   ├── .quick-send-title
  │   ├── .quick-send-item   ← visibleCommands 列表
  │   ├── divider
  │   └── .quick-send-item   ← 编辑按钮
  ├── QuickCommandDialog.vue ← 新增，lazy-load，命令管理对话框
  │   ├── ModalDialog (zIndex=2100)
  │   ├── draggable (vuedraggable, lazy-load)
  │   │   └── 命令行 (≡ 手柄 + 标签 + 命令 + ✏️ + 🗑)
  │   ├── + 添加命令按钮
  │   └── ModalDialog (嵌套, zIndex=2200) ← 命令编辑子对话框
  │       ├── 名称输入
  │       ├── 命令输入
  │       ├── ☐ 隐藏
  │       └── ☐ 自动执行
  └── useQuickCommands.ts    ← 数据管理 composable（模块级单例）
```

### 新增文件

| 文件 | 用途 |
|------|------|
| `web/src/components/terminal/QuickCommandDialog.vue` | 命令列表编辑对话框 + 嵌套命令编辑子对话框 |
| `web/src/composables/useQuickCommands.ts` | 数据管理 composable（模块级单例） |

### 修改文件

| 文件 | 变更 |
|------|------|
| `web/src/components/terminal/TerminalPanel.vue` | inline popup → PopupMenu；菜单底部编辑按钮；快捷命令按钮移除 `v-if`（始终显示），添加 `ref="cmdBtnRef"`；自动执行逻辑；导入 composable；移除 inline popup CSS |
| `web/src/utils/api.ts` | 新增 `apiPut` 工具函数 |
| `web/src/i18n/locales/en.ts` | 新增 terminal 快捷命令相关 i18n key；移除 `terminal.noQuickCommands` |
| `web/src/i18n/locales/zh.ts` | 新增 terminal 快捷命令相关 i18n key；移除 `terminal.noQuickCommands` |
| `web/package.json` | 新增 `vuedraggable@next` 依赖 |

### Composable：`useQuickCommands.ts`（模块级单例）

采用与 `useAutoSpeech` / `useToast` 相同的模块级单例模式，避免每次打开终端都重新 fetch。

```typescript
interface QuickCommand {
  id: number
  label: string
  command: string
  hidden: boolean
  auto_execute: boolean
  sort_order: number
}

// 模块级状态（单例）
const commands = ref<QuickCommand[]>([])
const loaded = ref(false)
const showEditDialog = ref(false)
const autoExecFired = ref(false)

export function useQuickCommands() {
  const visibleCommands = computed(() => commands.value.filter(c => !c.hidden))
  const autoExecCommand = computed(() => commands.value.find(c => c.auto_execute) || null)

  async function fetchCommands() { /* GET /api/terminal/quick-commands */ }
  async function addCommand(cmd: Partial<QuickCommand>) { /* POST */ }
  async function updateCommand(id: number, cmd: Partial<QuickCommand>) { /* PUT */ }
  async function deleteCommand(id: number) { /* DELETE, 乐观更新 */ }
  async function reorderCommands(ids: number[]) { /* PUT /reorder, {ids} */ }
  function resetAutoExec() { autoExecFired.value = false }

  return {
    commands, visibleCommands, autoExecCommand,
    fetchCommands, addCommand, updateCommand, deleteCommand, reorderCommands,
    showEditDialog, autoExecFired, resetAutoExec, loaded
  }
}
```

### 弹出菜单

现有 inline popup 替换为 `PopupMenu`，使用 `cmdBtnRef` 作为锚点元素（现有 ListIcon 按钮添加 `ref="cmdBtnRef"`）：

```vue
<PopupMenu v-model:show="showCommands" :target-element="cmdBtnRef"
  anchor="right" :max-width="220" :max-height="280"
  :menu-items-count="visibleCommands.length + 1">
  <div class="quick-send-title">{{ t('terminal.quickCommands') }}</div>
  <button v-for="cmd in visibleCommands" :key="cmd.id"
    class="quick-send-item" @click="executeCommand(cmd)">
    {{ cmd.label }}
  </button>
  <div class="quick-send-divider" />
  <button class="quick-send-item edit-item" @click="openEditDialog">
    ⚙️ {{ t('terminal.editCommands') }}
  </button>
</PopupMenu>
```

样式复用聊天快捷发送的 `.quick-send-title` / `.quick-send-item`。分隔线样式：

```css
.quick-send-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0;
}
```

### 编辑对话框

```
┌─────────────────────────────────┐
│  快捷命令                    ✕  │
├─────────────────────────────────┤
│  ≡  Git Status   git status   ✏️ 🗑│
│  ≡  🚀 Deploy    dep...      ✏️ 🗑│  ← auto_execute 标识
│  ≡  👁 Init       source ..   ✏️ 🗑│  ← hidden 标识（半透明）
├─────────────────────────────────┤
│  ＋ 添加命令                     │
├─────────────────────────────────┤
│           关闭                   │
└─────────────────────────────────┘
```

每行内容：≡ 拖动手柄 + 标签 + 命令文本（截断）+ 编辑图标 + 删除图标

标识规则：
- `auto_execute=1`：标签前 🚀
- `hidden=1`：标签前 👁，整行 `opacity: 0.6`
- 同时两者：🚀👁 都显示

拖动排序使用 vuedraggable，`handle` 指定 `.drag-handle`，拖动结束后调用 `reorderCommands` API。

### 命令编辑子对话框（嵌套 ModalDialog）

```
┌─────────────────────────────────┐
│  编辑命令                    ✕  │
├─────────────────────────────────┤
│  名称                            │
│  ┌─────────────────────────────┐│
│  │  Git Status                 ││
│  └─────────────────────────────┘│
│  命令                            │
│  ┌─────────────────────────────┐│
│  │  git status                 ││
│  └─────────────────────────────┘│
│                                  │
│  ☐ 隐藏（不在快捷菜单中显示）     │
│  ☐ 自动执行（打开终端时自动运行） │
│                                  │
│         取消      保存           │
└─────────────────────────────────┘
```

- 两个字段必填，保存时前端校验（非空 trim 后）+ 后端校验（1-100 / 1-4096 字符）
- 勾选"自动执行"时提示"将取消其他命令的自动执行标记"
- 外层 `ModalDialog` zIndex=2100（默认），内层 zIndex=2200

### 自动执行流程

1. composable 作为模块级单例，`fetchCommands()` 只在首次调用时请求 API（`loaded` 守卫）
2. `autoExecCommand` 计算属性返回 `auto_execute=1` 的命令
3. WebSocket 收到 `status` 事件后，检查 `autoExecFired` 和 `autoExecCommand`
4. **确保 `fetchCommands()` 在 `status` 事件之前完成**：在 `TerminalPanel.onMounted` 中先 `await fetchCommands()`，再建立 WebSocket 连接
5. 未执行过且有自动执行命令 → `session.sendInput(cmd.command + '\r')`，设置 `autoExecFired = true`
6. **终端重建**（rebuild，创建新 PTY）时调用 `resetAutoExec()`，允许再次自动执行
7. **WebSocket 重连**（不是 rebuild）时不调用 `resetAutoExec()`，`autoExecFired` 保持 true，不重复执行

关键不变量：`resetAutoExec()` 仅在后端保证发送新 `status` 事件时调用（即新 PTY 创建后）。

### 边界情况

| 场景 | 处理方式 |
|------|---------|
| 无命令时点快捷按钮 | 按钮始终显示（移除 `v-if`），菜单只有标题和编辑入口 |
| 全部命令都隐藏 | 菜单无命令项，只有编辑入口 |
| 设置自动执行时已有其他自动执行命令 | 后端先清除旧的 auto_execute，数据库 index 作为双保险 |
| 自动执行命令被删除 | 下次打开终端不执行 |
| 终端重建（rebuild） | `resetAutoExec()` 后收到新 status 事件再次自动执行 |
| WebSocket 重连（非 rebuild） | `autoExecFired` 保持 true，不重复执行 |
| fetchCommands 未完成时收到 status | onMounted 中先 await fetchCommands 再建连，保证时序 |
| 拖动排序后新增命令 | sort_order = MAX(sort_order)+1 |
| API 调用失败 | toast 提示错误；删除用乐观更新，失败则恢复 |
| 命令数量无上限 | 当前不做限制，未来可加 max 限制 |

### Lazy Loading

`QuickCommandDialog.vue` 使用 `defineAsyncComponent` 或动态 import 延迟加载，因为 vuedraggable + sortablejs 约 30KB，只在用户打开编辑对话框时才加载。

### 新增依赖

- `vuedraggable@next`（Vue 3 版本，基于 SortableJS）

### i18n Keys

```
terminal.quickCommands       = "快捷指令" / "Quick Commands"
terminal.editCommands        = "编辑" / "Edit"
terminal.addCommand          = "添加命令" / "Add Command"
terminal.editCommand         = "编辑命令" / "Edit Command"
terminal.commandLabel        = "名称" / "Label"
terminal.commandText         = "命令" / "Command"
terminal.commandHidden       = "隐藏（不在快捷菜单中显示）" / "Hidden (not shown in quick menu)"
terminal.commandAutoExecute  = "自动执行（打开终端时自动运行）" / "Auto execute (run when terminal opens)"
terminal.autoExecuteWarning  = "将取消其他命令的自动执行标记" / "This will disable auto-execute on other commands"
terminal.commandRequired     = "名称和命令不能为空" / "Label and command are required"
terminal.commandSaved        = "命令已保存" / "Command saved"
terminal.commandDeleted      = "命令已删除" / "Command deleted"
terminal.reorderFailed       = "排序失败" / "Reorder failed"
```

移除：`terminal.noQuickCommands`

## 实施步骤

1. **前端工具**：`api.ts` 新增 `apiPut`
2. **后端数据层**：`database.go` 新增表、index 和 CRUD 方法
3. **后端 API**：`terminal.go` 新增 `ServeQuickCommands` / `ServeQuickCommandByID` handler，`handler.go` 注册路由
4. **后端清理**：移除 config.go / manager.go / config.example.yaml 中的 QuickCommand 相关代码；修改 `TerminalConfigHandler` 响应
5. **后端输入校验**：handler 中校验 label/command 长度和非空
6. **前端 composable**：实现 `useQuickCommands.ts`（模块级单例）
7. **前端组件**：实现 `QuickCommandDialog.vue`（lazy-load）
8. **前端集成**：改造 `TerminalPanel.vue`（PopupMenu 替换、编辑入口、自动执行、移除 inline popup CSS）
9. **i18n**：添加中英文翻译，移除 `terminal.noQuickCommands`
10. **依赖**：安装 vuedraggable@next
11. **测试**：Go 单元测试（CRUD + auto_execute 唯一性 + 输入校验）+ 前端手动验证

## 审查记录

本设计经过架构审查和代码审查，以下问题已在此版本中解决：

| 原问题 | 解决方式 |
|--------|---------|
| C1: 缺少 project_path 列 | 确认为全局命令，不需要 project_path |
| C2: 自动执行重连竞态 | 明确 resetAutoExec 仅在新 PTY 创建时调用，重连不重置 |
| C3: auto_execute 唯一性无数据库保障 | 新增 partial unique index |
| C4: 前端无 apiPut | 新增 apiPut 工具函数 |
| C5: Go ServeMux 不支持 :id | 采用 ServeTaskByID 模式，TrimPrefix 提取 ID |
| M1: 缺少 Go struct 定义 | 新增 QuickCommand struct（JSON tags） |
| M2: reorderCommands 签名不匹配 | 简化为前端发 ID 列表，后端赋 sort_order=index |
| M3: 自动执行时序问题 | onMounted 先 await fetchCommands 再建连 |
| M4: 无输入校验 | 后端校验 label 1-100、command 1-4096 |
| M5: handler 不应检查终端启用 | 已明确不检查 terminalMgr.IsEnabled() |
| M6: updated_at 不自动更新 | 文档注明 UpdateQuickCommand 手动设置 |
| m3: composable 每次重建 | 改为模块级单例 |
| m4: noQuickCommands 死代码 | 移除 |
| m5: toolbar 按钮 v-if 和 ref | 明确移除 v-if、添加 ref |
| vuedraggable bundle size | lazy-load QuickCommandDialog |
