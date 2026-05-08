# R5: 定时任务流程 Review

> 日期: 2026-05-09 (重新审查)
> 审查范围: 前端CRUD → Cron调度 → Agent执行 → 结果持久化

## 审查范围

### 前端
- `web/src/components/task/TaskDrawer.vue` (1-377) — 任务列表抽屉
- `web/src/components/task/TaskFormDialog.vue` (1-618) — 任务创建/编辑表单
- `web/src/components/task/TaskExecDialog.vue` (1-461) — 执行历史详情

### 后端
- `internal/handler/scheduler.go` (1-258) — HTTP handler
- `internal/service/scheduler.go` (1-508) — 核心调度逻辑
- `internal/service/database.go` (1-241) — DDL + 持久化
- `internal/ai/factory.go` (1-28) — Backend 工厂
- `internal/ai/cli_backend.go` (1-231) — CLI 执行层
- `internal/model/scheduler.go` (1-25) — 数据模型
- `cmd/server/main.go` (1-494) — 启动编排

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 6.5/10

**分层清晰：** Handler → Service → AI 三层分离，Handler 做参数校验和 HTTP 适配，Service 做 Cron 调度和任务状态管理，AI 层做 CLI 执行。

**关键缺陷：**

- **缺少执行并发控制**：`robfig/cron` 默认调度器在 cron tick 时直接调用 FuncJob，不检查前一次执行是否完成。同一任务可重叠执行，导致 run_count 竞态、双重 CLI 进程、token 浪费
- **缺少执行超时**：`executeTask` 使用 `context.WithCancel(context.Background())` 无超时，CLI 可能永久挂起，goroutine 和进程永不退出
- **schedule-proposal 已移除但无服务端反递归**：旧版 `<schedule-proposal>` 被动标签检测已移除，当前反递归仅依赖 `CLAWBENCH_SCHEDULED` 环境变量，AI 可通过 CLI 工具绕过

### ✨ 代码质量 (30%) — 评分: 6.5/10

**亮点：**
- `Scheduler` 结构体使用 `sync.Mutex` 保护 cron 操作，`entryIDs` map 跟踪注册的任务
- `LoadTasksFromDB` 启动时恢复所有 active 任务，确保重启后不丢失
- `TaskFormDialog` 的 preset 系统提供 6 种预设 cron 模式，降低用户使用门槛

**缺陷：**
- DB.Exec 返回值全局性忽略（`scheduler.go:211,223,236,513`），SQLite 出错时任务状态静默不一致
- `UpdateTask` 中 `registerTaskLocked` 和 `saveTask` 非原子：先改 cron 注册（内存），再存 DB，中间失败导致不一致
- 前端 API 调用无统一封装，TaskDrawer 中 `fetch('/api/tasks/...')` 未传 Authorization header
- 前端 `TaskFormDialog` 的 cron 表达式验证不充分，不阻止极端频率

### 🛡️ 健壮性 (40%) — 评分: 4.5/10

**这是 12 个 Review 中健壮性评分最低的流程。**

| 场景 | 风险 | 严重度 |
|------|------|--------|
| 同一任务并发执行 | run_count 竞态、双重 CLI 进程、token 浪费 | **P0** |
| TriggerTask 无 running 检查 | 手动触发与自动触发并发 | **P0** |
| CLI 挂死无超时 | goroutine 和进程永不退出 | **P0** |
| DB 状态不一致 | 内存已更新但 DB 未更新，重启后恢复错误状态 | P1 |
| run_count 竞态 | limited repeat 模式下多执行同时递增，超出 max_runs | P1 |
| DB.Exec 错误静默忽略 | 任务状态与 DB 不一致，静默数据损坏 | P1 |
| 执行记录无分页 | 高频任务导致响应体积爆炸 | P1 |
| max_runs 缺少校验 | limited repeat 模式下 max_runs=0 导致无限执行 | P1 |

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R5-001 | **P0** | 🛡️ 健壮性 | Cron 回调无并发保护：同一任务可重叠执行 | `scheduler.go:322-329` | 添加 `runningTasks sync.Map` + CAS 检查，或使用 `SkipIfStillRunning` |
| R5-002 | **P0** | 🛡️ 健壮性 | 任务执行无超时：`context.WithCancel(context.Background())` 意味着挂死的 CLI 永远泄漏 goroutine | `scheduler.go:406` | 添加 `context.WithTimeout` 可配置超时（默认 30 分钟） |
| R5-003 | **P0** | 🛡️ 竞态 | TriggerTask 的 TOCTOU 竞态：`HasRunningExecutions` 检查和 `TriggerTask` 调用之间不原子 | `handler/scheduler.go:158-169` | 将 running 检查和执行启动合并为一个原子操作 |
| R5-004 | **P1** | 🛡️ 健壮性 | UpdateTask 中 `registerTaskLocked` 和 `saveTask` 非原子：cron 注册在锁内，DB 保存在锁外 | `scheduler.go:268-301` | 先 saveTask 再 registerTaskLocked，DB 失败时回滚内存 |
| R5-005 | **P1** | 🛡️ 竞态 | limited repeat 模式下 `run_count` 竞态：多执行同时递增 | `scheduler.go:484-495` | 在 runningTasks 标记内原子递增，或用 DB `SET run_count = run_count + 1` |
| R5-006 | **P1** | 🛡️ 健壮性 | DB.Exec 返回值系统性忽略：4 处调用不检查 err 或 RowsAffected | `scheduler.go:211,223,236,513` | 至少检查 err 并 log，关键路径 return error |
| R5-007 | **P1** | ✨ 质量 | 执行历史无分页：高频任务导致响应体积爆炸 | `handler/scheduler.go:251-284` | 添加 LIMIT/OFFSET 分页 |
| R5-008 | **P1** | 🛡️ 健壮性 | `repeat_mode == "limited"` 时不验证 `max_runs > 0` | `handler/scheduler.go:52` | 添加 `max_runs > 0` 校验 |
| R5-009 | **P1** | 🛡️ 健壮性 | `cron.ParseStandard` 错误被静默忽略 | `scheduler.go:497` | 返回错误，阻止无效 cron 表达式注册 |
| R5-010 | **P1** | 🛡️ 健壮性 | 反递归仅依赖 `CLAWBENCH_SCHEDULED` 环境变量，AI 可通过 CLI 工具绕过 | `cli_backend.go:43-45` | 在 handler 层添加二次检查或 rate limit |
| R5-011 | **P2** | ✨ 质量 | 系统提示反递归使用脆弱的字符串前缀替换 | `scheduler.go:380-391` | 使用 `<!-- SCHEDULED_BEGIN/END -->` 标记的精确替换 |
| R5-012 | **P2** | 🏗️ 架构 | agent_id 无外键约束；task_executions 无外键到 scheduled_tasks | `database.go:87-112` | 添加 FK 约束（SQLite 支持） |
| R5-013 | **P2** | 🛡️ 健壮性 | 生成的 `execID` 字符串从未存入 DB | `database.go:107` | 存储或移除生成逻辑 |
| R5-014 | **P2** | ✨ 质量 | TaskDrawer 的 `markAllTasksRead` 静默吞没错误 | `TaskDrawer.vue:109-114` | 至少 log 错误或显示 toast |
| R5-015 | **P2** | 🛡️ 健壮性 | 前端 cron 表达式无验证 | `TaskFormDialog.vue:94-99` | 前端也验证 cron 格式和最小间隔 |
| R5-016 | **P2** | ✨ 质量 | `Description` 字段是死代码 | `model/scheduler.go:10` | 移除或在 UI 中使用 |

---

## 改进建议 (Top 3)

1. **添加并发执行保护 (R5-001 + R5-003)**: 这是健壮性评分最低的根本原因。`robfig/cron` 默认不阻止重叠执行，同一任务可能同时运行 2+ 个 CLI 进程。建议：在 `Scheduler` 结构体增加 `runningTasks sync.Map`，`executeTask` 入口用 CAS 检查+设置 `runningTasks.Store(taskID, true)`，出口 `runningTasks.Delete(taskID)`；`TriggerTask` 也检查 running 标记，已在执行则返回 409 Conflict。或使用 `robfig/cron` 的 `WithChain(SkipIfStillRunning(cron.DefaultLogger))` 选项。预期收益：消除同一任务并发执行导致的 run_count 竞态和 token 浪费。

2. **添加执行超时兜底 (R5-002)**: `executeTask` 使用 `context.WithCancel(context.Background())` 意味着如果 CLI 挂死（如等待用户输入、网络不可达），goroutine 和进程永不退出。建议：改用 `context.WithTimeout` 设置可配置超时（默认 30 分钟），超时后自动 cancel CLI 进程并记录 timeout 错误到 `task_executions`。预期收益：消除 CLI 挂死导致 goroutine 泄漏的风险，确保系统长时间运行稳定。

3. **修复 DB.Exec 错误处理 + UpdateTask 原子性 (R5-006 + R5-004)**: 4 处 `DB.Exec` 调用系统性忽略返回值，SQLite 出错时任务状态静默不一致；`UpdateTask` 中 `registerTaskLocked`（内存）和 `saveTask`（DB）非原子，中间失败导致 cron 注册与 DB 状态分歧。建议：所有 `DB.Exec` 至少检查 `err` 并 log，关键路径 return error 给调用方；`UpdateTask` 改为先 `saveTask` 再 `registerTaskLocked`，DB 失败时不更新内存，或用事务包裹。预期收益：消除静默数据损坏，确保内存与 DB 状态一致。

---

## 亮点

- **LoadTasksFromDB 恢复机制**：启动时自动恢复所有 active 任务，确保重启后不丢失
- **authTracker 暴力破解防护**：指数退避 + IP 封锁，5 次失败后封禁 5 分钟，最大 1 小时
- **TaskFormDialog 的 preset 系统**：6 种预设 cron 模式（每5分钟/每小时/每天/每周/工作日/自定义），降低用户使用门槛
- **CLAWBENCH_SCHEDULED 反递归环境变量**：在 CLI 执行层注入环境变量，防止 AI 创建递归定时任务
