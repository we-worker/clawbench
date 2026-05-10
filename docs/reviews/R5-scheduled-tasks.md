# R5: 定时任务流程 Review

> 日期: 2026-05-10 (逐行精审)
> 审查范围: 前端CRUD → Cron调度 → Agent执行 → 结果持久化

## 审查范围

### 前端
- `web/src/components/task/TaskDrawer.vue` (1-425) — 任务列表抽屉，含创建/编辑/删除/执行历史入口
- `web/src/components/task/TaskFormDialog.vue` (1-686) — 任务创建/编辑表单，频率预设+自定义cron
- `web/src/components/task/TaskExecDialog.vue` (1-624) — 执行历史列表+详情，手动触发/取消

### 后端
- `internal/handler/scheduler.go` (1-286) — HTTP handler：CRUD + pause/resume/trigger/cancel + 执行历史查询
- `internal/handler/chat.go` (1-1025) — 聊天主流程（含ask-question检测，schedule-proposal已移除）
- `internal/service/scheduler.go` (1-671) — 核心调度逻辑：cron注册/执行/状态管理/DB持久化
- `internal/service/database.go` (1-433) — DDL + scheduled_tasks/task_executions表定义
- `internal/ai/factory.go` (1-28) — Backend工厂
- `internal/ai/cli_backend.go` (1-231) — CLI执行层，含CLAWBENCH_SCHEDULED注入
- `internal/ai/accumulate.go` (1-109) — 流式事件累积器
- `internal/model/scheduler.go` (1-35) — 数据模型
- `cmd/server/main.go` (1-593) — 启动编排（scheduler初始化顺序）

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7/10

**分层清晰：** Handler → Service → AI 三层分离合理。Handler做参数校验和HTTP适配，Service做Cron调度和任务状态管理，AI层做CLI执行。各层职责边界明确。

**亮点：**
- `Scheduler` 结构体将cron调度和运行时执行跟踪分离：`entries map` 管理 cron 注册，`runningExecutions sync.Map` 跟踪运行中的执行实例
- 反递归设计双重防护：`CLAWBENCH_SCHEDULED` 环境变量（CLI层）+ `BuildCommonPrompt(true)` 剥离定时任务技能（system prompt层）
- `TaskFormDialog` 的 preset 系统（hourly/daily/weekly/monthly/custom）降低cron使用门槛
- `TaskExecDialog` 复用 `ContentBlocks` + `chatRender` 渲染执行结果，避免重复实现markdown渲染

**关键缺陷：**
- **Cron回调无并发保护**：`robfig/cron` 默认调度器在 cron tick 时直接调用 `FuncJob`（:322-328），不检查前一次执行是否完成。同一任务可重叠执行，导致 run_count 竞态、双重 CLI 进程、token 浪费
- **缺少执行超时**：`executeTask` 使用 `context.WithCancel(context.Background())`（:406），注释明确写了"no timeout - let AI run indefinitely"，CLI 可能永久挂起
- **Action路由设计单一端点过载**：`ServeTaskByID` 的 PUT 方法通过 `action` 字段路由到 pause/resume/read/trigger/cancel/update 六种操作，语义混杂，增加了维护成本和安全审查难度

### ✨ 代码质量 (30%) — 评分: 6.5/10

**亮点：**
- `LoadTasksFromDB` 启动时恢复所有 active 任务，确保重启后不丢失；对无效 agent_id 只 warn 不 pause，因为 agent 可能尚未加载
- `registerTaskLocked` 在 cron 回调中从 DB 重新加载任务状态（:323-327），避免使用过期的闭包数据
- `detectPreset` 在编辑模式下智能检测现有 cron 表达式匹配的预设模式
- `runningExecutions` 使用 `sync.Map` 实现无锁的并发读写
- `executeTask` 的 defer 链正确清理：`runningExecutions.Delete` → `cancel()`

**缺陷：**
- DB.Exec 返回值全局性忽略（:211, 223, 236, 513-518），SQLite 出错时任务状态静默不一致
- `UpdateTask` 中 `registerTaskLocked` 和 `saveTask` 非原子：先改 cron 注册（内存，:268-279），再存 DB（:291-293），中间失败导致不一致
- 前端 API 调用无统一封装，`TaskDrawer` 中 `fetch('/api/tasks/...')` 未使用 `apiGet/apiPost` 工具函数（对比 `useQuickSend` 使用 `apiPost`）
- `serveTaskExecutions` 内定义 `Execution` struct（:244-249），应提取为 model 层类型
- 前端 `TaskFormDialog` 的 cron 表达式验证不充分：不阻止极端频率（如 `* * * * *`），不验证自定义 cron 格式合法性
- `extractSummary` 在 `TaskExecDialog.vue:199` 使用 `scheduled-task` 标签清理逻辑，但 schedule-proposal 机制已移除，清理逻辑残留

### 🛡️ 健壮性 (40%) — 评分: 5/10

**这是 12 个 Review 中健壮性评分最低的流程。**

| 场景 | 风险 | 严重度 |
|------|------|--------|
| 同一任务并发执行（cron auto + manual trigger） | run_count 竞态、双重 CLI 进程、token 浪费 | **P0** |
| TriggerTask 的 TOCTOU 竞态 | HasRunningExecutions 检查和 executeTask 启动之间不原子 | **P0** |
| CLI 挂死无超时 | goroutine 和进程永不退出，逐渐耗尽系统资源 | **P0** |
| DB 状态不一致 | 内存已更新但 DB 未更新，重启后恢复错误状态 | P1 |
| run_count 竞态 | limited repeat 模式下多执行同时递增，超出 max_runs | P1 |
| DB.Exec 错误静默忽略 | 任务状态与 DB 不一致，静默数据损坏 | P1 |
| 执行记录无分页 | 高频任务导致响应体积爆炸 | P1 |
| max_runs 缺少校验 | limited repeat 模式下 max_runs=0 导致永不完成 | P1 |

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R5-001 | **P0** | 🛡️ 健壮性 | Cron 回调无并发保护：cron tick 直接调用 `s.executeTask`（:328），不检查同一任务是否已在执行。若任务执行时间超过 cron 间隔，同一任务会重叠执行 | `scheduler.go:322-328` | 在 cron 回调中添加 `HasRunningExecutions(taskID)` 检查，或使用 `robfig/cron` 的 `SkipIfStillRunning` 选项。更优方案：在 `Scheduler` 增加 `runningTasks sync.Map`（key: taskID），`executeTask` 入口 CAS 检查+设置，出口删除 |
| R5-002 | **P0** | 🛡️ 健壮性 | TriggerTask 的 TOCTOU 竞态：handler 先调 `HasRunningExecutions(taskID)`（:160），再调 `TriggerTask`（:164），两步非原子。并发请求可通过检查窗口 | `handler/scheduler.go:158-169` | 将 running 检查和执行启动合并到 `TriggerTask` 内部，用 `sync.Map` CAS 操作保证原子性。若已在执行则返回 409 |
| R5-003 | **P0** | 🛡️ 健壮性 | 任务执行无超时：`context.WithCancel(context.Background())`（:406），注释"No timeout"。CLI 挂死（等用户输入、网络不可达、死循环）时 goroutine 和进程永不退出 | `scheduler.go:405-406` | 改用 `context.WithTimeout(ctx, cfg.TaskTimeout)` 可配置超时（默认 30 分钟），超时后 cancel CLI 进程并记录 timeout 到 task_executions |
| R5-004 | **P1** | 🛡️ 竞态 | limited repeat 模式下 `run_count` 竞态：多个并发执行同时读取 `currentCount`（:487），都判断不超限，都执行 `run_count = run_count + 1`（:513），导致实际执行次数超过 max_runs | `scheduler.go:484-518` | 在 `runningTasks` 标记内原子递增，或用 `UPDATE ... SET run_count = run_count + 1 WHERE run_count < max_runs` 条件更新，检查 RowsAffected 判断是否已超限 |
| R5-005 | **P1** | 🛡️ 健壮性 | UpdateTask 中 `registerTaskLocked` 和 `saveTask` 非原子：先改 cron 注册（内存，:268-279），再存 DB（:291-293）。DB 保存失败时内存已更新，重启后状态分歧 | `scheduler.go:268-301` | 先 `saveTask` 再 `registerTaskLocked`，DB 失败时不更新内存；或用事务包裹 cron 解注册 + DB 保存 |
| R5-006 | **P1** | 🛡️ 健壮性 | DB.Exec 返回值系统性忽略：`RemoveTask`（:211）、`PauseTask`（:223）、`ResumeTask`（:236）、`executeTask` 更新 run_count（:513-518）共 5 处调用不检查 err 或 RowsAffected | `scheduler.go:211,223,236,513-518` | 至少检查 err 并 log，关键路径 return error。特别是 :513-518 的状态更新失败会导致任务状态永久错误 |
| R5-007 | **P1** | 🛡️ 健壮性 | 执行历史无分页：`serveTaskExecutions`（:251）查询 `task_executions` 无 LIMIT，高频任务（如每分钟执行）积累大量记录，响应体积可达数 MB | `handler/scheduler.go:251-284` | 添加 LIMIT/OFFSET 分页参数，默认 LIMIT=50 |
| R5-008 | **P1** | 🛡️ 健壮性 | `repeat_mode == "limited"` 时不验证 `max_runs > 0`：前端可发送 `max_runs: 0`，导致 `currentCount+1 >= 0` 永远为 true，任务首次执行即标记 completed | `handler/scheduler.go:52` | 添加服务端校验：若 repeat_mode == "limited" 则 max_runs 必须 > 0 |
| R5-009 | **P1** | 🛡️ 健壮性 | `cron.ParseStandard` 错误在 `executeTask` 中被静默忽略（:497 `_ = cron.ParseStandard`），无效 cron 表达式导致 next_run_at 计算失败 | `scheduler.go:497` | 检查错误，记录到 task_executions，并暂停任务 |
| R5-010 | **P1** | 🛡️ 安全 | 反递归仅依赖 `CLAWBENCH_SCHEDULED` 环境变量，AI 可通过 `clawbench task create` CLI 命令绕过（环境变量只影响 CLI 进程内部，不影响子 shell） | `cli_backend.go:43-45` | 在 `cli/task.go` 的 RunTaskCommand 中检查 `CLAWBENCH_SCHEDULED` 环境变量，如果设置则拒绝创建任务 |
| R5-011 | **P2** | ✨ 质量 | 系统提示反递归使用脆弱的字符串前缀替换（:382-391）：`strings.HasPrefix(systemPrompt, normalCommon)` + 切片操作，若 common prompt 被修改（空格/换行变化）则匹配失败 | `scheduler.go:380-391` | 使用 `<!-- SCHEDULED_BEGIN/END -->` 标记的精确替换，与 `rules.md` 中的标记一致 |
| R5-012 | **P2** | 🏗️ 架构 | task_executions 无外键到 scheduled_tasks（:106-112），删除任务后执行记录成为孤儿数据 | `database.go:106-112` | 添加 `REFERENCES scheduled_tasks(id) ON DELETE CASCADE`，或明确设计为保留执行记录（软删除模式） |
| R5-013 | **P2** | 🛡️ 健壮性 | `task_executions` 表 `id` 列使用 `INTEGER PRIMARY KEY AUTOINCREMENT`（:107），但 `generateExecutionID()` 生成 `exec-` 前缀的 UUID 字符串（:668-670）。生成逻辑与表结构不匹配，execID 永远不会存入 DB 的 id 列 | `scheduler.go:344,668-670` | 要么 task_executions.id 改为 TEXT + 使用 execID，要么移除 generateExecutionID 改用 AUTOINCREMENT 生成的整数 ID |
| R5-014 | **P2** | ✨ 质量 | TaskDrawer 的 `markAllTasksRead` 并发发送所有 PUT 请求（:109-114），静默吞没所有错误（`.catch(() => {})`） | `TaskDrawer.vue:109-114` | 至少 log 错误或显示 toast；考虑串行化或批量 API |
| R5-015 | **P2** | ✨ 质量 | 前端 cron 表达式无验证：`TaskFormDialog` 的 custom 模式直接提交用户输入（:94-99），不验证格式合法性和最小间隔 | `TaskFormDialog.vue:94-99,290-300` | 前端也验证 cron 格式和最小间隔（建议 >= 1 分钟） |
| R5-016 | **P2** | ✨ 质量 | `Description` 字段是死代码（:10）：在 model 中定义但前后端从未使用 | `model/scheduler.go:10` | 移除或在 UI 中使用 |
| R5-017 | **P2** | ✨ 质量 | `extractSummary` 清理 `<scheduled-task>` 标签（:199-201），但 schedule-proposal 机制已移除，此清理逻辑为残留代码 | `TaskExecDialog.vue:199-201` | 移除无用的正则替换 |
| R5-018 | **P2** | 🛡️ 健壮性 | `serveTaskExecutions` 用 `task.LastReadAt` 判断未读（:270-277），但 `LastReadAt` 是从 DB 加载的 `*time.Time`（可能为 nil），nil 时所有执行标记为 unread，包括很久以前的执行 | `handler/scheduler.go:270-277` | 这是正确行为（nil = 从未读过），但应在文档中明确 |
| R5-019 | **P2** | ✨ 质量 | `TaskDrawer.vue:152-157` 的 watch 在 drawer 打开时并行调用 `loadTasks()` 和 `loadAgents()`，然后调用 `markAllTasksRead()`。`markAllTasksRead` 不等待 `loadTasks` 完成，可能操作过期的 tasks 列表 | `TaskDrawer.vue:152-157` | `markAllTasksRead` 应在 `loadTasks` 完成后调用（改为 `await loadTasks(); markAllTasksRead()`） |
| R5-020 | **P3** | ✨ 质量 | `serveTaskExecutions` 内定义局部 `Execution` struct（:244-249），与 model 层 `RunningExecutionView` 命名相似但语义不同 | `handler/scheduler.go:244-249` | 提取为 model 层类型，避免命名混淆 |
| R5-021 | **P3** | ✨ 质量 | `TaskFormDialog` 的 `errors` 对象在服务端错误时统一设置到 `cronExpr` 字段（:335,341），即使是其他字段导致的错误 | `TaskFormDialog.vue:335,341` | 根据错误类型设置到对应字段，或使用通用错误区域 |
| R5-022 | **P3** | ✨ 质量 | `executeTask` 在 AI backend 执行失败时（:423-432）不记录到 `task_executions`，也不更新 `run_count`。下次 cron tick 会再次执行，但用户看不到失败原因 | `scheduler.go:423-432` | 记录失败执行到 task_executions（含错误信息），让用户在 UI 中看到失败原因 |

---

## 改进建议 (Top 3)

1. **添加并发执行保护 (R5-001 + R5-002 + R5-004)**: 这是健壮性评分最低的根本原因。`robfig/cron` 默认不阻止重叠执行，同一任务可能同时运行 2+ 个 CLI 进程。建议：在 `Scheduler` 增加 `runningTasks sync.Map`（key: taskID），`executeTask` 入口用 `LoadOrStore` CAS 检查+设置，出口 `Delete`；`TriggerTask` 也检查 running 标记，已在执行则返回 409 Conflict；cron 回调中也检查。同时修复 limited repeat 的 run_count 竞态，改用条件更新 `WHERE run_count < max_runs`。预期收益：消除同一任务并发执行导致的 run_count 竞态和 token 浪费，这是生产环境最可能触发的问题。

2. **添加执行超时兜底 (R5-003)**: `executeTask` 使用 `context.WithCancel(context.Background())` 意味着如果 CLI 挂死（如等待用户输入、网络不可达、死循环），goroutine 和进程永不退出。建议：改用 `context.WithTimeout` 设置可配置超时（默认 30 分钟），超时后自动 cancel CLI 进程并记录 timeout 错误到 `task_executions`。同时在 `cmd.Wait()` 后检查 `ctx.Err()` 以区分正常完成和超时取消。预期收益：消除 CLI 挂死导致 goroutine 泄漏的风险，确保系统长时间运行稳定。

3. **修复 DB 操作错误处理 + UpdateTask 原子性 (R5-005 + R5-006)**: 5 处 `DB.Exec` 调用系统性忽略返回值，SQLite 出错时任务状态静默不一致；`UpdateTask` 中 `registerTaskLocked`（内存）和 `saveTask`（DB）非原子，中间失败导致 cron 注册与 DB 状态分歧。建议：所有 `DB.Exec` 至少检查 `err` 并 log，关键路径 return error 给调用方；`UpdateTask` 改为先 `saveTask` 再 `registerTaskLocked`，DB 失败时不更新内存，或用事务包裹。预期收益：消除静默数据损坏，确保内存与 DB 状态一致。

---

## 亮点

- **LoadTasksFromDB 恢复机制**：启动时自动恢复所有 active 任务，对无效 agent_id 只 warn 不 pause（可能尚未加载），missed execution 也有日志提醒
- **反递归双重防护**：`CLAWBENCH_SCHEDULED` 环境变量 + `BuildCommonPrompt(true)` 剥离定时任务技能，两层保护防止 AI 递归创建定时任务
- **TaskFormDialog 的 preset 系统**：4 种预设 cron 模式（hourly/daily/weekly/monthly）+ custom，编辑时 `detectPreset` 自动匹配预设，降低使用门槛
- **runningExecutions 跟踪机制**：`sync.Map` 跟踪运行中执行实例，支持取消和状态查询，前端可实时看到运行状态并取消
- **TaskExecDialog 复用渲染**：复用 `ContentBlocks` + `chatRender` 渲染执行结果，避免重复实现 markdown/tool_use 渲染
- **执行取消安全**：`CancelExecution` 通过 `context.CancelFunc` 优雅取消，`CancelAllExecutions` 在删除任务前清理运行中执行
- **startup 顺序正确**：`LoadAgents` 在 `NewScheduler` + `LoadTasksFromDB` 之前执行（:444-482），确保 agent_id 验证可用
