# R3: Auto-Resume 流程 Review

> 日期: 2026-05-24
> 审查范围: ExitPlanMode检测 → 取消CLI → 自动续传 → resume_split事件

## 审查范围

### 后端
- `internal/ai/factory.go` (1-23) — AutoResumeBackend 包装
- `internal/ai/auto_resume.go` (1-174) — 核心逻辑
- `internal/ai/stream_parser.go` (1-329) — ExitPlanMode 检测
- `internal/ai/cli_backend.go` (1-225) — context 取消
- `internal/handler/chat.go` (1-1084) — resume_split 处理

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
- Phase 2 不检测嵌套 ExitPlanMode（`auto_resume.go:141` 注释 "no nested ExitPlanMode detection"），如果 resume 后 AI 再次进入 Plan 模式，CLI 会挂死
- `forwardEvent` 在 channel 满时 drop event，`resume_split` 事件也可能被 drop — handler 未收到 `resume_split` 时消息分割逻辑失效

### ✨ 代码质量 (30%) — 评分: 8.0/10

**代码简洁：**
- `auto_resume.go` 仅 174 行，逻辑清晰，两个 phase 通过 `goto phase1Done` 分隔
- `mergeStreams` 的注释详尽，解释了每个设计决策

**关注点：**
- `goto` 在 Go 中虽不禁止，但可改为提取 `phase2()` 函数更清晰
- Resume 请求硬编码 prompt 为 "continue"（`auto_resume.go:120`），不随 agent 语言适配
- Phase 2 抑制 `raw_output`（`auto_resume.go:149-151`）但没有注释说明原因，应该是避免前端显示 CLI resume 命令的原始输出

**CLI 进程清理：**
- `innerCancel()` 取消 context → `exec.CommandContext` 发送 SIGKILL → CLI 进程确保被杀
- drain 循环（`auto_resume.go:89-94`）确保 channel 中剩余事件被消费，不会泄漏 goroutine
- 孙进程问题已在 R1 中标记（R1-003），但 auto_resume 场景下风险更高——因为 cancel 发生在 AI 执行中途

### 🛡️ 健壮性 (40%) — 评分: 7.9/10

**两阶段切换原子性：**
- Cancel 旧 CLI → 启动新 CLI 之间存在时间窗口，但设计上没有状态不一致的风险：
  - `resume_split` 事件确保 handler 先 finalize 旧消息，再开始累积新消息
  - 旧 CLI 的 drain 循环确保不会产生"幽灵事件"污染新 stream
- 唯一风险：如果 `resume_split` 被 drop（channel full），handler 不会分割消息，前后两段内容会合并到同一条 assistant 消息

**消息持久化一致性：**
- Handler 在收到 `resume_split` 时（`chat.go`）：
  1. Finalize 当前 assistant 消息到 DB（设 streaming=false）
  2. 创建新的 assistant 消息（streaming=true）
- 问题：finalize 旧消息和创建新消息不在同一事务中，如果中间崩溃，DB 中会有：
  - 一条 finalized 的前半段消息 ✅
  - 缺失后半段消息 ❌
- 但 service 层有 orphaned streaming message 清理（`database.go:165-214`），重启时会标记为 cancelled

**Resume 失败处理：**
- `auto_resume.go:132-138`：resume 启动失败时发送 `done` 事件
- 问题（与 R1-017 一致）：handler 收到 `done` 会正常 finalize，前端无法区分"正常完成"和"resume 失败"
- 但消息状态一致——至少不会产生永远 loading 的消息

**嵌套 ExitPlanMode：**
- Phase 2 不检测嵌套 ExitPlanMode，如果 AI resume 后再次进入 Plan 模式：
  - CLI 会在 `--print` 模式下挂起等待用户审批
  - 后端不会自动 resume，SSE 会在 60s 后超时
  - 前端会显示超时提示，用户可以手动重新发送消息
- 这不是 bug 而是 conscious design choice（注释已说明），但用户体验不佳

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R3-001 | **P2** | 🛡️ 健壮性 | 嵌套 ExitPlanMode 未处理：resume 后 AI 再次进入 Plan 模式会导致 CLI 挂死 | `auto_resume.go:141` | 添加嵌套 ExitPlanMode 检测，或设置超时后自动发 "继续" |
| R3-002 | **P2** | 🛡️ 健壮性 | `resume_split` 事件可能被 drop（channel full），handler 未收到时消息分割失效 | `auto_resume.go:82` | `resume_split` 应使用保证投递的发送方式（阻塞发送或重试） |
| R3-003 | **P2** | 🛡️ 健壮性 | resume 请求 prompt 硬编码 "continue"，不随 agent 语言适配 | `auto_resume.go:120` | 从 agent 配置读取 resume prompt，或根据 system_prompt 语言选择 "继续"/"continue" |
| R3-004 | **P2** | 🛡️ 健壮性 | resume 失败时发 `done` 而非 error，前端无法区分正常完成和 resume 失败 | `auto_resume.go:137` | 发送包含错误信息的 warning + done，或发 error 事件 |
| R3-005 | **P2** | 🛡️ 健壮性 | finalize 旧消息和创建新消息不在同一事务中，崩溃时可能产生孤立 streaming 消息 | `handler/chat.go` resume_split 处理 | 用事务包裹两步操作 |
| R3-006 | **P2** | ✨ 质量 | Phase 2 抑制 `raw_output` 但无注释说明原因 | `auto_resume.go:149-151` | 添加注释说明为什么 resume stream 的 raw_output 不需要显示 |
| R3-007 | **P3** | ✨ 质量 | `goto phase1Done` 可提取为函数 | `auto_resume.go:95` | 提取 `b.executeResumePhase(ctx, origReq, outerCh)` 函数 |
| R3-008 | **P3** | ✨ 质量 | `forwardEvent` 函数名与 channel full drop 语义不匹配 | `auto_resume.go:165` | 重命名为 `trySendEvent` 或 `sendOrDropEvent` |

---

## 改进建议 (Top 3)

1. **`resume_split` 事件保证投递 (R3-002)**: 当前 `resume_split` 通过 `forwardEvent` 发送，channel 满时被 drop。如果 handler 未收到，前后两段消息会合并到一条，破坏了消息分割的语义。建议：`resume_split` 应使用阻塞发送（`ch <- event`），或在 channel 满时增大 buffer 后重试。预期收益：确保消息分割逻辑始终正确执行。

2. **嵌套 ExitPlanMode 处理 (R3-001)**: Resume 后 AI 可能再次进入 Plan 模式，导致 CLI 挂死。建议：Phase 2 也添加 ExitPlanMode 检测，设置最大 resume 次数（如 3 次），超过后发 warning + done 通知前端。预期收益：消除 CLI 挂死风险，改善用户体验。

3. **Resume prompt 适配 (R3-003)**: 硬编码 "continue" 在中文 agent 场景下不自然。建议：从 agent 配置中读取 `resume_prompt` 字段，默认值根据 `agent_common_prompt.md` 的语言自动选择 "继续" 或 "continue"。预期收益：中文 agent 下的 AI 响应更自然。

---

## 亮点

- **装饰器模式完全透明**：外层调用者无需知道 AutoResumeBackend 的存在，唯一的"泄露"是 `resume_split` 事件
- **drain 循环设计精巧**：cancel 后继续消费 innerCh 中的 raw_output，避免日志丢失；同时抑制 done 事件，防止 handler 误判为正常完成
- **两阶段 context 隔离**：innerCtx 和 innerCtx2 是独立的，cancel 旧 CLI 不影响新 CLI
- **factory.go 的简洁包装**：只需在 `NewBackend` 中为 claude/codebuddy 包装 `AutoResumeBackend`，对其他后端透明
