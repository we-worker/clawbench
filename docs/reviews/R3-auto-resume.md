# R3: Auto-Resume 流程 Review

> 日期: 2026-05-09 (重新审查)
> 审查范围: ExitPlanMode检测 → 取消CLI → 自动续传 → resume_split事件

## 审查范围

### 后端
- `internal/ai/factory.go` (1-28) — AutoResumeBackend 包装
- `internal/ai/auto_resume.go` (1-183) — 核心逻辑
- `internal/ai/stream_parser.go` (1-361) — ExitPlanMode 检测
- `internal/ai/cli_backend.go` (1-231) — context 取消、进程管理
- `internal/handler/chat.go` (1-1025) — resume_split 处理、消息分割

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.5/10

**装饰器模式设计优秀：**
- `AutoResumeBackend` 完全透明地包装内层 backend，外层调用者（handler）无需知道是否被 auto-resume 包装
- 两阶段流合并通过单个 `outerCh` 对外暴露，消费者只看到一个连续的事件流
- `resume_split` 事件是唯一的"泄露"——handler 需要此事件来分割 DB 消息，但 SSE 消费者（前端）不感知

**两阶段切换设计：**
- Phase 1：检测 ExitPlanMode → 转发事件 + 发送 resume_split → 取消 CLI → drain 剩余事件
- Phase 2：创建新 context → 启动 resume CLI → 转发事件（抑制 raw_output）
- 阶段切换点选择合理：ExitPlanMode tool_use 的 `Done=true` 是唯一可靠的检测点

**关注点：**
- Phase 2 不检测嵌套 ExitPlanMode，如果 resume 后 AI 再次进入 Plan 模式，CLI 会挂死
- `forwardEvent` 在 channel 满时 drop event，`resume_split` 事件也可能被 drop — handler 未收到时消息分割逻辑失效

### ✨ 代码质量 (30%) — 评分: 8.0/10

**代码简洁：**
- `auto_resume.go` 仅 183 行，逻辑清晰，两个 phase 通过 `goto phase1Done` 分隔
- `mergeStreams` 的注释详尽，解释了每个设计决策

**关注点：**
- `goto` 在 Go 中虽不禁止，但可改为提取 `phase2()` 函数更清晰
- Resume 请求硬编码 prompt 为 "continue"（`auto_resume.go:127`），不随 agent 语言适配
- Phase 2 抑制 `raw_output` 但没有注释说明原因

**CLI 进程清理：**
- `innerCancel()` 取消 context → `exec.CommandContext` 发送 SIGKILL → CLI 进程确保被杀
- drain 循环确保 channel 中剩余事件被消费，不会泄漏 goroutine
- 但 `exec.CommandContext` 的 SIGKILL 不传播到孙进程，auto_resume 场景下（cancel 发生在 AI 执行中途）孤儿进程风险更高

### 🛡️ 健壮性 (40%) — 评分: 7.5/10

**两阶段切换原子性：**
- Cancel 旧 CLI → 启动新 CLI 之间存在时间窗口，但设计上没有状态不一致的风险：
  - `resume_split` 事件确保 handler 先 finalize 旧消息，再开始累积新消息
  - 旧 CLI 的 drain 循环确保不会产生"幽灵事件"污染新 stream
- 唯一风险：如果 `resume_split` 被 drop（channel full），handler 不会分割消息，前后两段内容会合并到同一条 assistant 消息

**进程管理缺陷：**
- `cli_backend.go:39` 的 `exec.CommandContext` 无进程组管理，`innerCancel()` 只杀死 CLI 主进程，孙进程（如 shell 子进程）成为孤儿
- drain 循环（`auto_resume.go:95-100`）在 `innerCancel()` 后无超时，如果 CLI 的 stdout pipe 不关闭（僵尸进程），drain 将无限阻塞

**嵌套 ExitPlanMode：**
- Phase 2 不检测嵌套 ExitPlanMode，如果 AI resume 后再次进入 Plan 模式：
  - CLI 会在 `--print` 模式下挂起等待用户审批
  - 后端不会自动 resume，SSE 会在 60s 后超时
  - 虽然有注释说明是 conscious design choice，但用户体验不佳且可能导致 CLI 进程泄漏

**消息持久化一致性：**
- Handler 在收到 `resume_split` 时：finalize 当前 assistant 消息 → 创建新的 assistant 消息
- 两次 DB 操作不在同一事务中，中间崩溃会产生孤立 streaming 消息（但 service 层有 orphaned message 清理）

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R3-001 | **P0** | 🛡️ 泄漏 | 无进程组管理：`innerCancel()` 后 CLI 孙进程成为孤儿 | `cli_backend.go:39` | 使用 `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` + 进程组 kill |
| R3-002 | **P0** | 🛡️ 健壮性 | Phase 2 无嵌套 ExitPlanMode 检测：AI resume 后再次进入 Plan 模式导致 CLI 挂死 | `auto_resume.go:148-170` | 添加嵌套检测 + 最大 resume 次数（3次），超限发 warning + done |
| R3-003 | **P1** | 🛡️ 健壮性 | drain 循环在 `innerCancel()` 后无超时：僵尸 pipe 可导致无限阻塞 | `auto_resume.go:95-100` | 添加 5s 超时 context |
| R3-004 | **P1** | 🛡️ 健壮性 | Phase 2 raw_output 被抑制，调试数据丢失 | `auto_resume.go:157-158` | 至少 log raw_output，或添加配置项 |
| R3-005 | **P1** | 🛡️ 健壮性 | ExitPlanMode 检测依赖 `Done=true`：如果 CLI 不发 `content_block_stop`，auto-resume 永不触发 | `stream_parser.go` + `auto_resume.go:80` | 增加 `content_block_start` + 超时兜底 |
| R3-006 | **P1** | ✨ 质量 | `phase1Done` label 处的 guard 是死代码 | `auto_resume.go:117-120` | 移除或添加注释说明保留原因 |
| R3-007 | **P2** | 🛡️ 泄漏 | `innerCancel` 未 defer：panic/early return 时 CLI 进程可能泄漏 | `auto_resume.go:30-31` | `defer innerCancel()` 确保始终清理 |
| R3-008 | **P2** | 🛡️ 健壮性 | `forwardEvent` 可 drop `resume_split`/`done` 等关键事件 | `auto_resume.go:174-182` | 关键事件使用阻塞发送 |
| R3-009 | **P2** | ✨ 质量 | `eventCount` 在 resume 后重置又立即递增，计数不准确 | `chat.go:550,580` | 保留累加计数 |
| R3-010 | **P2** | ✨ 质量 | 墙钟定时器在 resume 后重置，累计时长丢失 | `chat.go:551` | 累加时长而非重置 |
| R3-011 | **P2** | 🏗️ 架构 | `factory.go` 中共享 CLIBackend 实例，当前安全但脆弱 | `factory.go` | 文档说明线程安全前提或每次创建新实例 |
| R3-012 | **P2** | ✨ 质量 | raw_output 在正常流程中被发送两次 | `cli_backend.go:110-115,199-204` | 去重或文档说明两次发送的原因 |
| R3-013 | **P3** | ✨ 质量 | 硬编码 "continue" 不支持 i18n | `auto_resume.go:127` | 从 agent 配置读取或根据 system_prompt 语言选择 |
| R3-014 | **P3** | ✨ 质量 | Codex 未被 AutoResumeBackend 包装，未在文档中说明 | `factory.go:19` | 添加注释说明原因 |
| R3-015 | **P3** | 🛡️ 健壮性 | resume 失败时创建空 DB 消息 | `chat.go:553-560` | 检查 resume 结果，空消息不持久化 |

---

## 改进建议 (Top 3)

1. **添加 CLI 进程组管理 (R3-001)**: `exec.CommandContext` 的 SIGKILL 不传播到孙进程，在 auto_resume 场景下（cancel 发生在 AI 执行中途）孤儿进程风险尤其高。建议：使用 `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` 创建进程组，`innerCancel()` 时通过 `syscall.Kill(-pgid, SIGTERM)` → 3s → `syscall.Kill(-pgid, SIGKILL)` 清理整个进程树。预期收益：消除 CLI 孤儿进程泄漏。

2. **添加嵌套 ExitPlanMode 检测 + 最大重试次数 (R3-002)**: Phase 2 不检测嵌套 ExitPlanMode，AI resume 后再次进入 Plan 模式会导致 CLI 挂死。建议：Phase 2 也添加 ExitPlanMode 检测，维护 `resumeCount` 计数器，最大重试 3 次，超限后发 warning + done 通知前端。预期收益：消除 CLI 挂死风险，改善用户体验。

3. **添加 drain 超时防止无限阻塞 (R3-003)**: `innerCancel()` 后的 drain 循环（`auto_resume.go:95-100`）依赖 CLI 的 stdout pipe 关闭，如果僵尸进程持有 pipe 不放，drain 将无限阻塞，导致 goroutine 泄漏。建议：使用 `context.WithTimeout(innerCtx, 5*time.Second)` 创建 drain context，超时后放弃 drain 直接进入 Phase 2。预期收益：消除 drain 无限阻塞导致的 goroutine 泄漏。

---

## 亮点

- **装饰器模式完全透明**：外层调用者无需知道 AutoResumeBackend 的存在，唯一的"泄露"是 `resume_split` 事件
- **drain 循环设计精巧**：cancel 后继续消费 innerCh 中的 raw_output，避免日志丢失；同时抑制 done 事件，防止 handler 误判为正常完成
- **两阶段 context 隔离**：innerCtx 和 innerCtx2 是独立的，cancel 旧 CLI 不影响新 CLI
- **factory.go 的简洁包装**：只需在 `NewBackend` 中为 claude/codebuddy/qoder 包装 `AutoResumeBackend`，对其他后端透明
