# R5: 定时任务流程 Review

> 日期: 2026-05-24
> 审查范围: 前端CRUD → Cron调度 → Agent执行 → 结果持久化

## 审查范围

### 前端
- `web/src/components/task/TaskDrawer.vue` (1-377) — 任务列表抽屉
- `web/src/components/task/TaskFormDialog.vue` (1-618) — 任务创建/编辑表单
- `web/src/components/task/TaskExecDialog.vue` (1-461) — 执行历史详情

### 后端
- `internal/handler/scheduler.go` (1-258) — HTTP handler
- `internal/handler/chat.go` (834-962) — AI 生成任务注入
- `internal/service/scheduler.go` (1-508) — 核心调度逻辑
- `internal/service/database.go` (1-241) — DDL + 持久化
- `internal/ai/factory.go` (1-23) — Backend 工厂
- `internal/ai/cli_backend.go` (1-225) — CLI 执行层
- `internal/ai/accumulate.go` (1-91) — 流式事件聚合
- `internal/model/scheduler.go` (1-25) — 数据模型
- `cmd/server/main.go` (1-494) — 启动编排

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.0/10

**分层清晰：** Handler → Service → AI 三层分离，Handler 做参数校验和 HTTP 适配，Service 做 Cron 调度和任务状态管理，AI 层做 CLI 执行。schedule-proposal 的自动创建是亮点设计。

**关键缺陷：**
- **缺少执行并发控制**：`robfig/cron` 默认调度器在 cron tick 时直接调用 FuncJob，不检查前一次执行是否完成。同一任务可重叠执行
- **缺少 proposal 审批流**：AI 输出的 `<schedule-proposal>` 被自动解析并创建定时任务，无需用户确认
- **缺少执行超时**：`executeTask` 使用 `context.WithCancel(context.Background())` 无超时，CLI 可能永久挂起
- Handler 和 Service 层的 cron 表达式验证不充分

### ✨ 代码质量 (30%) — 评分: 7.0/10

**亮点：**
- `Scheduler` 结构体使用 `sync.Mutex` 保护 cron 操作，`entryIDs` map 跟踪注册的任务
- `LoadTasksFromDB` 启动时恢复所有 active 任务，确保重启后不丢失
- schedule-proposal 的正则解析和自动创建逻辑完整

**缺陷：**
- DB.Exec 返回值全局性忽略（`scheduler.go:106,118,131,355-361`），SQLite 出错时任务状态静默不一致
- `UpdateTask` 中 `registerTaskLocked` 和 `saveTask` 非原子：先改 cron 注册（内存），再存 DB，中间失败导致不一致
- 前端 API 调用无统一封装，所有 `fetch('/api/tasks/...')` 均未传 Authorization header
- `TaskFormDialog.vue` 的 `detectPreset` 不支持范围 cron 表达式（`*/5`、`1-5`）

### 🛡️ 健壮性 (40%) — 评分: 5.0/10

**这是 12 个 Review 中健壮性评分最低的流程。**

| 场景 | 风险 | 严重度 |
|------|------|--------|
| 同一任务并发执行 | run_count 竞态、双重 CLI 进程、token 浪费 | **P0** |
| AI 构造恶意 cron | `* * * * *` 每分钟执行、unlimited repeat | **P0** |
| TriggerTask 无 running 检查 | 手动触发与自动触发并发 | **P0** |
| CLI 挂死无超时 | goroutine 和进程永不退出 | P1 |
| DB 状态不一致 | 内存已更新但 DB 未更新，重启后恢复错误状态 | P1 |
| 执行记录无分页 | 高频任务导致响应体积爆炸 | P1 |
| error 事件不 AccumulateBlock | 执行失败时 blocks 为空，丢失错误信息 | P2 |

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R5-001 | **P0** | 🛡️ 健壮性 | Cron 任务无并发保护，同一任务可重叠执行 | `scheduler.go:217-224` | 添加 `runningTasks map[string]bool` 或使用 `robfig/cron` 的 `SkipIfStillRunning` |
| R5-002 | **P0** | 🛡️ 安全 | schedule-proposal 自动创建任务无用户确认，AI 可构造恶意 cron | `chat.go:897-909` | 默认设为 `status: "paused"`，需用户手动激活；限制 cron 最小间隔 |
| R5-003 | **P0** | 🛡️ 健壮性 | TriggerTask 无 running 检查，手动触发可与自动执行并发 | `scheduler.go:140-147` | 加入 running 检查，已在执行则返回冲突错误 |
| R5-004 | **P1** | 🛡️ 健壮性 | executeTask 无超时，CLI 可能永久挂起 | `scheduler.go:271-272` | 添加可配置超时（如 30 分钟） |
| R5-005 | **P1** | 🛡️ 健壮性 | DB.Exec 返回值全局性忽略，出错时状态静默不一致 | `scheduler.go:106,118,131,355` | 检查 result.RowsAffected() 或至少 err |
| R5-006 | **P1** | 🏗️ 架构 | UpdateTask 中 registerTaskLocked 和 saveTask 非原子 | `scheduler.go:150-196` | 先 saveTask 再 registerTask，失败时回滚内存 |
| R5-007 | **P1** | 🛡️ 健壮性 | serveTaskExecutions 缺少分页，高频任务响应体积爆炸 | `scheduler.go:223-233` | 添加 LIMIT/OFFSET 分页 |
| R5-008 | **P1** | 🛡️ 健壮性 | cron 表达式验证不充分，不阻止极端频率 | `scheduler.go:47-49` + `scheduler.go:81-84` | 添加最小间隔校验（>= 5 分钟） |
| R5-009 | **P2** | ✨ 质量 | 前端 API 调用无 Authorization header，无统一封装 | `TaskDrawer.vue:98,113,146,155,166` | 使用 apiGet/apiPost 封装 |
| R5-010 | **P2** | 🛡️ 健壮性 | markAllTasksRead 并发竞争 + 错误吞没 | `TaskDrawer.vue:108-121` | 串行化请求或至少 log 错误 |
| R5-011 | **P2** | 🛡️ 健壮性 | error 事件不经过 AccumulateBlock，执行失败时 blocks 为空 | `scheduler.go:291-302` | 在 error 分支也调用 AccumulateBlock |
| R5-012 | **P2** | 🛡️ 健壮性 | 任务删除使用软删除但无清理机制，DB 持续膨胀 | `scheduler.go:98-107` | 定期清理 deleted 状态的任务和执行记录 |
| R5-013 | **P2** | ✨ 质量 | 前端 confirm() 在移动端 WebView 表现不一致 | `TaskDrawer.vue:164` | 改用自定义确认对话框 |
| R5-014 | **P2** | ✨ 质量 | TaskFormDialog 验证不覆盖后端约束 | `TaskFormDialog.vue:281-291` | 前端也验证 cron 格式和 maxRuns |
| R5-015 | **P3** | ✨ 质量 | TaskExecDialog 不刷新执行列表 | `TaskExecDialog.vue` | triggerTask 成功后调用 loadExecutions() |
| R5-016 | **P3** | ✨ 质量 | detectPreset 不支持范围 cron 表达式 | `TaskFormDialog.vue:243-278` | 支持常见 cron 模式 |
| R5-017 | **P3** | ✨ 质量 | scheduler.go:175 冗余 else if 条件 | `scheduler.go:175` | 简化为 else |

---

## 改进建议 (Top 3)

1. **添加 Cron 任务并发保护 (R5-001+R5-003)**: 在 `Scheduler` 结构体增加 `runningTasks sync.Map`，`executeTask` 入口 CAS 检查+设置，出口清除。或使用 `robfig/cron` 的 `WithChain(SkipIfStillRunning(cron.DefaultLogger))` 选项。TriggerTask 也检查 running 标记。预期收益：消除同一任务并发执行导致的 run_count 竞态和 token 浪费。

2. **schedule-proposal 需用户确认 (R5-002)**: AI 输出的 `<schedule-proposal>` 自动创建任务应默认设为 `status: "paused"`，前端显示确认对话框，用户确认后才激活。同时限制 cron 表达式最小间隔（>= 5 分钟）和 unlimited repeat 的自动创建。预期收益：消除 AI 被诱导创建恶意任务的风险。

3. **添加执行超时兜底 (R5-004)**: `executeTask` 应使用 `context.WithTimeout` 设置可配置超时（默认 30 分钟），超时后自动 cancel CLI 进程并记录 timeout 错误。预期收益：消除 CLI 挂死导致 goroutine 泄漏的风险。

---

## 亮点

- **schedule-proposal 设计理念**：AI 输出中自动检测定时任务需求并创建，是创新的 AI-agent 交互模式
- **LoadTasksFromDB 恢复机制**：启动时自动恢复所有 active 任务，确保重启后不丢失
- **authTracker 暴力破解防护**：指数退避 + IP 封锁，5 次失败后封禁 5 分钟，最大 1 小时
- **TaskFormDialog 的 preset 系统**：6 种预设 cron 模式（每5分钟/每小时/每天/每周/工作日/自定义），降低用户使用门槛
