# R3: Auto-Resume 流程 Review

> 日期: 2026-05-10
> 审查范围: ExitPlanMode检测 → 取消CLI → 自动续传 → resume_split事件

## 审查范围

### 核心逻辑
- `internal/ai/auto_resume.go` (183行) — AutoResumeBackend 装饰器，两阶段流合并，ExitPlanMode 检测与自动续传
- `internal/ai/factory.go` (28行) — 工厂方法，将 claude/codebuddy/qoder 后端包装为 AutoResumeBackend
- `internal/ai/stream_parser.go` (445行) — StreamParser，content_block_start/stop 中 ExitPlanMode 的 tool_use 事件生成

### 调用方
- `internal/ai/cli_backend.go` (231行) — CLIBackend，context 取消传播与 CLI 进程生命周期
- `internal/handler/chat.go` (1025行) — executeStreamRun / resume_split 处理 / DB 消息持久化

### 辅助文件（交叉引用）
- `internal/ai/interface.go` — AIBackend 接口、StreamEvent/ChatRequest 类型定义
- `internal/ai/accumulate.go` — AccumulateBlock，block 聚合与去重逻辑
- `internal/service/session_runtime.go` — 会话取消与取消原因追踪

## 三维度评估

### 🏗️ 架构设计 (30%)

**装饰器模式运用得当。** AutoResumeBackend 采用装饰器模式包装 inner AIBackend，对外暴露单一连续的 `<-chan StreamEvent`，对内透明地完成两阶段切换。这是正确的抽象层次——调用方（handler）无需关心 ExitPlanMode 的存在，只需处理 `resume_split` 事件做消息边界切分。

**factory.go 的包装策略一致但隐式。** claude、codebuddy、qoder 被包装为 AutoResumeBackend，其余后端不包装。这由 CLI 行为决定（只有这三个 CLI 在 `--print` 模式下遇到 ExitPlanMode 会挂起），但代码中没有注释解释为什么只有这三个需要包装，未来添加新后端时容易遗漏。

**两阶段流合并的状态机使用 goto。** `mergeStreams` 中 Phase 1 → Phase 2 的切换使用 `goto phase1Done` 跳转，这在 Go 中不常见。虽然逻辑上是正确的（Phase 1 drain 完成后跳转到 Phase 2），但可读性不如将 Phase 2 提取为独立函数。

**resume_split 事件设计的职责边界清晰。** AutoResumeBackend 只负责发出 `resume_split` 信号，handler 层负责 DB 消息的 finalize + create。这种分层避免了 AI 层直接依赖 DB 操作。

**不足：AutoResumeBackend 没有实现嵌套 ExitPlanMode 的防护。** Phase 2 明确注释了"no nested ExitPlanMode detection"，但如果 AI 在 resume 后再次触发 ExitPlanMode，当前代码会将其作为普通 tool_use 事件转发，不会自动续传。这是有意为之的限制，但缺少用户可见的警告。

### ✨ 代码质量 (30%)

**命名与注释质量高。** `auto_resume.go` 的注释完整解释了两阶段逻辑、`resume_split` 的用途、以及 Phase 1/2 的行为差异。`forwardEvent` 的"dropping if full"策略也有明确注释。

**StreamParser 的 tool_use 检测逻辑正确。** ExitPlanMode 的检测条件是 `event.Type == "tool_use" && event.Tool != nil && event.Tool.Name == "ExitPlanMode" && event.Tool.Done`，要求 Done=true 才触发，这确保了只在完整工具调用结束时才执行续传，避免在 input 还在增量到达时过早触发。

**forwardEvent 的静默丢弃策略有争议。** 当 channel 满时，事件被丢弃并仅记录 warn 日志。对于 `resume_split` 这种关键控制事件，丢弃可能导致 handler 不创建新的 DB 消息，后续 resume 内容写入已 finalize 的消息。不过实际场景中 channel buffer 为 64，且 SSE 消费者通常很快，风险较低。

**Phase 1 drain 循环只保留 raw_output。** 取消后 drain 剩余事件时，只转发 `raw_output`，丢弃其他事件（包括可能的 `done`、`metadata`）。这是正确的——取消的流不应产生新的 metadata/done，但如果有正在传输的 `content` 事件在管道中，它们会被静默丢弃，可能导致消息尾部内容丢失。

**ChatRequest 构建使用了硬编码 "continue"。** Phase 2 的 resumeReq.Prompt 固定为 "continue"，这是 CLI `--resume` 模式下继续会话的标准提示，但不可配置。如果某些后端需要不同的续传提示，需要修改此处。

### 🛡️ 健壮性 (40%)

**P1: 两阶段切换的原子性存在窗口。** 在 `innerCancel()` 调用后、Phase 2 `ExecuteStream` 启动前，存在一个时间窗口。如果在此期间外层 `ctx` 被取消（用户主动取消），Phase 2 的 `ExecuteStream` 会立即失败。代码处理了这种情况（`err != nil` 时发出 done），但 Phase 1 的 `innerCancel` 会触发 `sessionCancelReasons` 被设置为 "disconnect"（如果此时 SSE 断开），导致 `finalizeStreamRun` 将 Phase 2 消息标记为 cancelled，即使 Phase 2 尚未产生内容。

**P1: resume_split 后 DB 消息创建失败会终止整个流。** `chat.go:555-560` 中，如果 `AddChatMessage` 创建新 streaming 消息失败，返回 `streamRunResult{err: "failed to create resume streaming message"}`，整个 goroutine 结束。此时 Phase 2 的 AutoResumeBackend 仍在运行，其事件无人消费，直到外层 ctx 取消或 channel 满后阻塞。这会导致短暂的 goroutine 泄漏（直到 ctx 取消），以及丢失 Phase 2 的内容。

**P2: rawOutput 在 resume_split 时重置但 drain 可能覆盖。** `chat.go:536-545` 在处理 `resume_split` 时，先保存 rawOutput 再重置。但 `raw_output` 事件在 `executeStreamRun` 中通过 `continue` 跳过了 `AccumulateBlock`，而 resume_split 之前的最后一个 `raw_output` 可能还未到达（在 channel 中排队），导致 rawOutput 可能为空或只包含部分内容。

**P2: Phase 1 的 cancelled "done" 事件被抑制但 channel 关闭触发补充 done。** `auto_resume.go:71-73`：当 innerCh 关闭（不是通过 "done" 事件，而是因为 context 取消导致 channel close），代码会补充一个 `done` 事件。但在 ExitPlanMode 场景下，Phase 1 的 drain 循环（line 95-100）显式抑制了 done 事件，然后 `goto phase1Done` 跳过了这个补充逻辑。这是正确行为，但依赖 `goto` 的跳转目标来保证，如果将来代码重构不小心将 drain 逻辑移到 select 循环外，可能引入 bug。

**P2: AutoResumeBackend 不支持并发 ExecuteStream。** 由于 `mergeStreams` 中 `innerCancel` 取消的是整个 innerCtx，如果同一个 AutoResumeBackend 实例被多个 goroutine 调用 `ExecuteStream`（虽然当前代码不会这样做），一个调用的 ExitPlanMode 取消会影响另一个。factory.go 每次创建新实例，所以当前安全，但类型定义上没有防护。

**P2: AccumulateBlock 对 resume_split 事件不处理。** `accumulate.go` 的 switch 中没有 `resume_split` case，这意味着 `resume_split` 事件被 AccumulateBlock 忽略，这是正确的——但依赖隐式的 default 行为，如果将来添加了 default 分支的日志或处理，可能产生意外效果。

**P3: streamChanSize 常量在 interface.go 中定义为 64，但 RegisterSessionStream 也硬编码了 64。** 两处 buffer 大小应保持一致，但分别定义。

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R3-001 | P1 | 健壮性 | resume_split 后 AddChatMessage 失败导致 Phase 2 goroutine 泄漏 | `chat.go:555-560` | 失败时只记日志，不终止流；Phase 2 内容追加到前一消息或存为独立消息 |
| R3-002 | P1 | 健壮性 | Phase 1→2 切换窗口中外层 ctx 取消可能导致 Phase 2 消息被错误标记为 cancelled | `auto_resume.go:91-138` | 在 innerCancel 前记录切换状态，finalizeStreamRun 检查此状态避免误标 |
| R3-003 | P2 | 健壮性 | Phase 1 drain 丢弃非 raw_output 事件，可能导致 Phase 1 尾部 content 丢失 | `auto_resume.go:95-100` | 考虑在 drain 时也转发 content/thinking 事件（它们属于 Phase 1 的合法输出） |
| R3-004 | P2 | 质量 | factory.go 缺少注释解释为什么只有 claude/codebuddy/qoder 需要 AutoResume 包装 | `factory.go:10-21` | 添加注释说明原因（这三个 CLI 在 --print 模式下 ExitPlanMode 会挂起） |
| R3-005 | P2 | 质量 | mergeStreams 使用 goto 控制流，可读性不佳 | `auto_resume.go:101,117-120` | 提取 Phase 2 为独立方法 `startResumePhase`，消除 goto |
| R3-006 | P2 | 健壮性 | forwardEvent 静默丢弃关键控制事件（如 resume_split）可能导致状态不一致 | `auto_resume.go:174-182` | 对 resume_split 等控制事件使用阻塞发送或至少记录更高级别日志 |
| R3-007 | P2 | 健壮性 | Phase 2 不检测嵌套 ExitPlanMode，如果 AI 再次触发则不自动续传且无警告 | `auto_resume.go:148` | 添加检测并发出 warning 事件通知前端 |
| R3-008 | P2 | 健壮性 | rawOutput 在 resume_split 保存时可能为空（raw_output 事件仍在 channel 中排队） | `chat.go:536-545` | 在 finalize 前做一次 channel drain 以获取最终的 raw_output |
| R3-009 | P2 | 架构 | 续传 prompt 硬编码 "continue"，不可配置 | `auto_resume.go:127` | 考虑从 ChatRequest 或 agent config 读取续传提示 |
| R3-010 | P3 | 质量 | streamChanSize (interface.go:126) 和 RegisterSessionStream buffer (session_runtime.go:133) 各自硬编码 64 | `interface.go:126`, `session_runtime.go:133` | 统一引用同一常量 |
| R3-011 | P3 | 质量 | exitPlanModeDetected 的冗余检查 — phase1Done 标签后的 `if !exitPlanModeDetected` 永远为 true（只有 goto 才到达此处且此时 exitPlanModeDetected 必为 true） | `auto_resume.go:118-120` | 移除冗余检查或改为防御性断言 |
| R3-012 | P3 | 健壮性 | AccumulateBlock 对 resume_split 无显式处理，依赖 switch default 忽略 | `accumulate.go:37` | 添加显式 `case "resume_split":` 以明确意图 |

## 改进建议 (Top 3)

1. **处理 resume_split 后 DB 创建失败**: 当前 AddChatMessage 失败会导致整个流终止，Phase 2 goroutine 泄漏。建议改为：失败时记录错误但不终止，将 Phase 2 内容追加到已有消息（通过 UpdateStreamingMessage），或接受消息可能包含两段内容。预期收益: 消除 P1 级别的数据丢失和 goroutine 泄漏风险。

2. **重构 mergeStreams 消除 goto**: 将 Phase 2 逻辑提取为独立方法（如 `startResumePhase`），Phase 1 完成后直接调用。这不仅提升可读性，也使 Phase 1/2 的边界更清晰，减少 goto 跳过状态清理代码的风险。预期收益: 提升可维护性，降低未来重构引入 bug 的概率。

3. **Phase 2 添加嵌套 ExitPlanMode 检测与警告**: 当 resume 后 AI 再次触发 ExitPlanMode 时，发出 warning 事件通知前端，而不是静默忽略。虽然不应该无限递归自动续传，但用户应知道 AI 仍处于 plan mode。预期收益: 改善用户体验，避免 AI 静默卡在 plan mode。

## 亮点

- **装饰器模式设计精良**: AutoResumeBackend 完全透明地包装 inner backend，外层调用方只需处理 `resume_split` 事件，不需要理解两阶段切换的细节。这种"对调用方最小化暴露"的设计非常优秀。
- **Done=true 守卫条件**: ExitPlanMode 检测要求 `event.Tool.Done == true`，确保只在工具调用输入完成后才触发续传，避免在 input_json_delta 还在增量到达时过早中断。
- **resume_split 事件实现简洁的 DB 边界切分**: handler 层通过 `resume_split` 事件做消息 finalize + create，实现了干净的两条 DB 消息对应一次逻辑交互，前端渲染也自然分两条消息。
- **forwardEvent 的非阻塞策略**: 对 SSE 实时流采用"丢弃胜于阻塞"的策略，配合独立的 DB 持久化，确保流处理不会因前端消费慢而背压到 AI 后端。
- **Phase 2 的 raw_output 抑制**: resume 流的 raw_output 被抑制，避免 Phase 2 的原始输出覆盖 Phase 1 的调试数据，是细节考虑到位的表现。
