# R1: Chat 主流程 Review

> 日期: 2026-05-24
> 审查范围: 前端输入 → Handler → AI Backend → CLI → StreamParser → SSE → 前端渲染

## 审查范围

### 前端
- `web/src/components/chat/ChatInputBar.vue` (1-1118)
- `web/src/components/chat/ChatPanel.vue` (1-749)
- `web/src/composables/useChatSession.ts` (1-513)
- `web/src/composables/useChatStream.ts` (1-536)
- `web/src/composables/useChatRender.ts` (1-361)
- `web/src/composables/useSessionIdentity.ts` (1-212)
- `web/src/composables/useAutoSpeech.ts` (1-326)
- `web/src/composables/useFileUpload.ts` (1-164)
- `web/src/composables/useAgents.ts` (1-53)
- `web/src/composables/useQuoteQuestion.ts` (1-214)
- `web/src/utils/api.ts` (1-38)
- `web/src/components/chat/ChatMessageList.vue` (1-463)
- `web/src/components/chat/ChatMessageItem.vue` (1-881)
- `web/src/components/chat/ContentBlocks.vue` (1-1233)
- `web/src/components/chat/ChatMetadataModal.vue` (1-301)
- `web/src/composables/useMarkdownRenderer.ts` (1-176)
- `web/src/utils/renderToolDetail.ts` (1-616)

### 后端
- `internal/handler/handler.go` (1-217)
- `internal/handler/chat.go` (1-1084)
- `internal/handler/chat_stream.go` (1-179)
- `internal/handler/chat_session.go` (1-149)
- `internal/handler/chat_history.go` (1-129)
- `internal/handler/agent.go` (1-18)
- `internal/handler/queue.go` (1-112)
- `internal/service/session_runtime.go` (1-173)
- `internal/service/chat.go` (1-381)
- `internal/service/database.go` (1-241)
- `internal/service/queue.go` (1-109)
- `internal/model/chat.go` (1-51)
- `internal/model/agent.go` (1-117)
- `internal/model/errors.go` (1-93)
- `internal/model/config.go` (1-105)
- `internal/ai/interface.go` (1-110)
- `internal/ai/factory.go` (1-23)
- `internal/ai/cli_backend.go` (1-225)
- `internal/ai/stream_parser.go` (1-329)
- `internal/ai/accumulate.go` (1-91)

### 数据层
- SQLite via `internal/service/database.go`
- `chat_sessions` / `chat_history` / `chat_messages` 表

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.8/10

**层次边界：** Handler → Service → Model/DB 三层分离清晰。前端 ChatPanel → Composables → API 分层合理。但有几处越界：
- `handler.go:108` `resolveAgentConfig()` 直接读取 `model.Agents` 全局变量，Handler 层直接耦合了 Model 层的配置状态
- `handler/chat.go:332` AI goroutine 内调用了 `buildChatRequest()`，其中又调用 `service.SessionHasAssistant()` / `service.GetAssistantMessageCount()` — 本质上是 Service 逻辑，但放在了 Handler 里
- `handler/chat.go:623` `detectAndCreateScheduleProposals()` 直接调用 `service.GlobalScheduler.AddTask()` — Handler 承担了业务编排职责
- `useChatRender` 的 `renderTextBlock` 中解析 `<schedule-proposal>` 和 `<ask-question>` 标签并修改 `blockProposals`/`blockAskQuestions` 响应式状态，属于副作用型渲染

**职责单一：** `chat.go` (1084行) 是唯一明显过大的后端文件，同时承担了 HTTP路由处理、AI goroutine生命周期、流事件累积/持久化、schedule-proposal检测/创建。前端 `useChatSession` 同时包含session CRUD、消息轮询、全局轮询（含task unread检测），职责过宽。

**接口设计：** `AIBackend` 接口精简（Name + ExecuteStream），`LineParser` 接口扩展性好。`CLIBackend` 用回调函数实现模板方法模式。前端 Composable 拆分合理，`useSessionIdentity` 的控制反转设计巧妙。

**耦合度：**
- Service 层重度依赖包级全局变量（`DB`, `activeSessions`, `sessionStreams`, `sessionCancels`, `sessionQueues`）
- `messages` ref 在多处被直接修改（`useChatStream` push/修改属性、`useChatSession` 替换），没有统一的状态管理层
- API调用风格不统一：`useChatSession`用裸`fetch`，`useAgents`用`apiGet`

**扩展性：** 新增 AI Backend 只需实现 `AIBackend`/`LineParser` + 在 `factory.go` 加 case + 注册 agent YAML。前端 `renderToolDetail.ts` 的注册表模式支持工具扩展零侵入。

### ✨ 代码质量 (30%) — 评分: 7.4/10

**设计模式：**
- `CLIBackend` 的回调组合模式是亮点 — 避免了 5 个 Backend 子类的代码重复
- `AutoResumeBackend` 装饰器模式 — 透明包装 ExitPlanMode 逻辑
- `renderToolDetail.ts` 注册表模式 — 开放-封闭原则
- `useSessionIdentity` 控制反转 — 解决单例与组件生命周期冲突

**代码重复：**
- Session 自动创建逻辑在 `AIChat GET/POST`、`ServeSessions POST`、`ServeChatHistory GET` 中重复 4 次，变量命名不一致 (`sessionBackend2`, `defaultModel2`, `agentID2`)
- `parseMessages` 逻辑在 `useChatSession:88-102` 和 `useChatStream:158-168` 中重复
- `Object.keys(xxx).forEach(k => delete xxx[k])` 模式在 `useChatSession` 中重复 3 次

**命名/注释：**
- 注释质量高，关键设计决策都有注释说明
- `sessionBackend2` / `defaultModel2` 后缀命名混乱
- `streamRunResult.cancelReason` 用字符串而非枚举

**错误处理：**
- 结构化错误体系（`AppError` + 哨兵错误 + i18n）设计完善
- Handler 层存在两种错误响应路径并行：`writeLocalizedError` (有 i18n) vs `model.WriteError` (无 i18n)
- SSE 事件 `JSON.parse` 无 try-catch 防护

**类型安全：**
- 前端核心数据结构 `messages: Ref<any[]>`、`blockProposals: reactive({})` 缺少接口定义
- `StreamEvent.Type` 是字符串，事件类型 switch 无 exhaustive 检查
- `sessionCancelReasons` 的 value 用 `any` 存储

### 🛡️ 健壮性 (40%) — 评分: 7.2/10

**竞态条件：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `session_runtime.go:99-113` + `chat.go:321` | `CancelSession` 与 goroutine defer 对 `sessionStreams` 存在 close-after-write 竞态 | **P0** |
| `useChatStream.ts:401-433` | `queue_consume` 事件 push 后 `lastIndex` 闭包变量与其他事件间存在索引不一致窗口 | P1 |
| `useAutoSpeech.ts:189-215` | `es.onerror` 和 `result` 事件可能同时触发，双重调用 `handleResult` | P1 |
| `chat.go:362` | 50ms sleep 重试 DequeueMessage 是 ad-hoc 竞态缓解 | P2 |

**资源泄漏：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `cli_backend.go:38` | `exec.CommandContext` SIGKILL 不传播到孙进程，产生孤儿进程 | **P1** |
| `useFileUpload.ts:31-83` | XHR 请求在组件卸载后不会 abort | P1 |
| `session_runtime.go:152-158` | `UnregisterSessionStream` close channel 后，如果 goroutine 继续写会 panic | P1 |
| `useChatRender.ts:14-15` | `blockProposals` reactive 对象只增不减，长会话缓慢增长 | P2 |

**边界条件：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `useChatStream.ts:249,265,279` | SSE 事件 `JSON.parse` 无 try-catch，畸形数据导致整个 stream 崩溃 | **P0** |
| `chat.go:448` | 空的 streaming placeholder 写入 DB，如果所有事件被 drop 则产生空 assistant 消息 | P2 |
| `useChatSession.ts:313-322` | `deleteSession` 后 `createSession()` 失败时 `currentSessionId` 指向已删除会话 | P1 |

**错误传播链：**
- `cli_backend.go:143-148` scanner.Err 发 warning 后继续执行，如果 cmd 正常退出则发 done — 语义矛盾
- `auto_resume.go:131-138` resume 启动失败时发 `done`，handler 认为正常完成
- `useChatStream.ts:467-488` error 事件中二次 `JSON.parse(e.data)` 也无防护

**安全漏洞：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `chat_session.go:145` | `HttpOnly: false` 的 session cookie 可被 XSS 窃取 | P2 |
| `handler.go:207` | `/api/ssh/info` 无需认证，暴露 SSH 端口和指纹 | P2 |
| `chat.go:834` | `schedule-proposal` 自动创建定时任务，AI 可被诱导生成恶意 cron | P2 |
| `chat.go:244,247` | 服务器绝对路径泄露到 AI 上下文 | P2 |

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R1-001 | **P0** | 🛡️ 健壮性 | `CancelSession` 与 goroutine defer 对 `sessionStreams` 存在 close-after-write 竞态，可导致 send-on-closed-channel panic | `session_runtime.go:99-113` + `chat.go:321` | CancelSession 不应直接写 streamCh，改用 SendSessionEvent 或仅设标记让 goroutine 自行发终态事件 |
| R1-002 | **P0** | 🛡️ 安全 | SSE 事件 `JSON.parse` 无 try-catch，畸形数据导致整个 stream 崩溃 | `useChatStream.ts:249,265,279` | 包裹 try-catch，失败时 log 并跳过该事件 |
| R1-003 | **P1** | 🛡️ 健壮性 | CLI 子进程的孙进程不被 SIGKILL 清理，产生孤儿进程 | `cli_backend.go:38` | 使用 `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` + 进程组杀灭 |
| R1-004 | **P1** | 🛡️ 健壮性 | `UnregisterSessionStream` close channel 后 goroutine 继续写会 panic | `session_runtime.go:152-158` | `sendEvent` 应 recover from panic 或用 atomic flag 标记 channel 状态 |
| R1-005 | **P1** | 🛡️ 竞态 | `queue_consume` 事件 push 后 `lastIndex` 闭包变量与实际数组不一致 | `useChatStream.ts:401-433` | 改为 `messages.value.find(m => m.role === 'assistant' && m.streaming)` 动态查找 |
| R1-006 | **P1** | 🛡️ 竞态 | `useAutoSpeech` 中 `es.onerror` 和 `result` 事件双重调用 `handleResult` | `useAutoSpeech.ts:189-215` | 添加 `resultHandled` 标志位 |
| R1-007 | **P1** | 🛡️ 泄漏 | `useFileUpload` 的 XHR 请求在组件卸载后不会 abort | `useFileUpload.ts:31-83` | 改用 `fetch` + `AbortController` 或维护活跃 XHR 列表 |
| R1-008 | **P1** | 🛡️ 健壮性 | `deleteSession` 后 `createSession()` 失败时 `currentSessionId` 指向已删除会话 | `useChatSession.ts:313-322` | createSession 失败时重置 currentSessionId 为空 |
| R1-009 | **P1** | ✨ 质量 | Session 自动创建逻辑重复 4 次，变量名不一致 | `chat.go:82-108,158-179` + `chat_session.go:30-89` + `chat_history.go:24-45` | 提取为 `ensureSession()` 辅助函数 |
| R1-010 | **P1** | ✨ 质量 | 错误响应存在两条路径并行：有/无 i18n | `chat.go` 多处 | 统一为 `writeLocalizedError` |
| R1-011 | **P1** | 🏗️ 架构 | `chat.go` 1084 行，职责过重 | `handler/chat.go` | 拆分：goroutine 逻辑提取为 `service/ai_executor.go`，schedule-proposal 提取为 `service/schedule_proposal.go` |
| R1-012 | **P2** | 🛡️ 安全 | `HttpOnly: false` 的 session cookie 可被 XSS 窃取 | `chat_session.go:145` | 设为 `HttpOnly: true` |
| R1-013 | **P2** | 🛡️ 安全 | `/api/ssh/info` 无需认证 | `handler.go:207` | 加 `middleware.Auth` 保护 |
| R1-014 | **P2** | 🛡️ 安全 | `schedule-proposal` 自动创建定时任务无确认 | `chat.go:834-928` | 增加频率限制或用户确认 |
| R1-015 | **P2** | 🛡️ 健壮性 | `AccumulateBlock` 的 `json.Unmarshal` 忽略错误 | `accumulate.go:60` | 至少 log warning |
| R1-016 | **P2** | 🛡️ 健壮性 | `scanner.Err()` 发 warning 后继续执行可能发 `done` | `cli_backend.go:143-148` | warning 后 continue 等待 cmd.Wait 再决定终态 |
| R1-017 | **P2** | 🛡️ 健壮性 | `auto_resume.go:137` resume 失败时发 `done` | `auto_resume.go:131-138` | 发 `error` 事件而非 `done` |
| R1-018 | **P2** | 🏗️ 架构 | Service 层全部使用包级全局变量，无法多实例化 | `session_runtime.go:11-21` | 引入 `Runtime` struct 持有状态 |
| R1-019 | **P2** | 🛡️ 健壮性 | `DeleteSession` 删除消息和 session 不在同一事务内 | `chat.go:270-279` | 用事务包裹两次 DELETE |
| R1-020 | **P2** | ✨ 质量 | `convertAskQuestionBlocks` 每次调用都编译正则 | `chat.go:980` | 提升为包级变量 |
| R1-021 | **P2** | ✨ 质量 | `streamRunResult.cancelReason` 用字符串而非枚举 | `chat.go:403-407` | 定义 `type CancelReason int` 枚举 |
| R1-022 | **P2** | ✨ 质量 | `parseMessages` 逻辑重复 | `useChatSession.ts,useChatStream.ts` | 提取共享函数 |
| R1-023 | **P2** | ✨ 质量 | 核心数据结构缺少 TypeScript 接口定义 | 多文件 | 定义 ChatMessage、ContentBlock 等接口 |
| R1-024 | **P2** | ✨ 质量 | API 调用风格不统一 | `useChatSession.ts,ChatPanel.vue` | 统一使用 apiGet/apiPost |
| R1-025 | **P2** | 🛡️ 健壮性 | `blockProposals` reactive 对象只增不减 | `useChatRender.ts:14-15` | switchSession 时清除旧 key |
| R1-026 | **P2** | 🛡️ 健壮性 | `renderMarkdown` 每次调用都 `document.getElementById` | `useChatRender.ts:75-78` | 合并到 debounce render |
| R1-027 | **P2** | 🛡️ 健壮性 | error 事件中二次 `JSON.parse(e.data)` 也无防护 | `useChatStream.ts:467-488` | 包裹 try-catch |
| R1-028 | **P2** | ✨ 质量 | `chat.go:826` 自定义 `min()` 函数，Go 1.21+ 有内建 | `chat.go:826` | 删除，使用内建 `min` |
| R1-029 | **P2** | ✨ 质量 | `useQuoteQuestion.sendMessage` 中 `langPrefix` 在无 language 时为 `':'` | `useQuoteQuestion.ts:159` | 无 language 时 `langPrefix` 应为空字符串 |
| R1-030 | **P2** | 🛡️ 健壮性 | `SetSessionRunning(false)` 在 CancelSession 和 goroutine defer 都调用 | `session_runtime.go:111` + `chat.go:320` | 使用 `sync.Once` 或 CAS 语义 |
| R1-031 | **P3** | ✨ 质量 | `ServeChatCount` 获取 sessionID 后赋值给 `_` | `chat_history.go:103` | 移除或实际校验 |
| R1-032 | **P3** | ✨ 质量 | CSS 中硬编码颜色值与 CSS 变量重复 | `ChatInputBar.vue` 多处 | 统一使用 CSS 变量 |
| R1-033 | **P3** | ✨ 质量 | `useChatRender` 的 `options` 参数无类型定义 | `useChatRender.ts:10` | 定义 UseChatRenderOptions 接口 |
| R1-034 | **P3** | ✨ 质量 | `ChatMetadataModal` 使用已废弃的 `document.execCommand('copy')` | `ChatMetadataModal.vue:116-117` | 改用 `navigator.clipboard.writeText` |
| R1-035 | **P3** | ✨ 质量 | `ContentBlocks.vue:76` 中 `|| true` 短路了 `expandedTools` | `ContentBlocks.vue:76` | 移除 `|| true` |

---

## 改进建议 (Top 3)

1. **修复 channel close/write 竞态 (R1-001+R1-004)**: `CancelSession` 与 AI goroutine 的清理逻辑存在竞态，可导致 send-on-closed-channel panic（生产崩溃级）。建议：引入 `streamClosed` atomic bool 标记，`sendEvent` 检查此标记后再发送；`CancelSession` 不直接写 channel，改为设置 cancel reason 后让 goroutine 自行发终态事件。预期收益：消除当前最严重的并发 bug。

2. **SSE 事件解析增加防御性错误处理 (R1-002+R1-027)**: 所有 SSE 事件处理中的 `JSON.parse` 都需要 try-catch 防护。一旦后端输出异常数据，未捕获异常会中断整个 EventSource 事件循环。同时对 error 事件中的二次 parse 也加防护。预期收益：消除前端 stream 崩溃风险。

3. **提取 Session 自动创建辅助函数 + 拆分 chat.go (R1-009+R1-011)**: 4 处重复的 session 自动创建逻辑提取为 `ensureSession()` 辅助函数；chat.go 的 AI goroutine 生命周期管理提取为 `service/ai_executor.go`，schedule-proposal 提取为 `service/schedule_proposal.go`。预期收益：chat.go 从 1084 行降至 ~400 行，消除重复代码，职责边界清晰。

---

## 亮点

- **AutoResumeBackend 装饰器模式**：透明包装 ExitPlanMode 逻辑，`resume_split` 事件设计巧妙
- **CLIBackend 回调组合模式**：5 个后端共享 CLI 执行框架，通过回调注入差异，避免继承和代码重复
- **useSessionIdentity 控制反转设计**：单例持有身份 refs，ChatPanel 注册操作回调，优雅解决 Vue composable 单例与组件生命周期冲突
- **SSE 三层容错架构**：EventSource 重连(3次) → HTTP 轮询 → 全局会话轮询，每层都能独立恢复状态
- **renderToolDetail.ts 注册表模式**：renderer + action handler + auto-expand 三个并行注册表，工具扩展零侵入
- **switchSession 序列号竞态防护**：简洁的 `++switchSessionSeq` 方案，比 Promise cancellation 轻量
- **流式渲染节流**：ContentBlocks 的 `blockHtmlCache` + `THROTTLE_MS`，streaming 结束时 watch 清理缓存
- **Orphaned streaming message 清理**：启动时自动将崩溃遗留的 streaming=1 消息标记为 cancelled
- **增量持久化策略**：每 5 个事件 + 每 1s ticker 双触发，SSE channel full 时 drop event 但 DB 已持久化
- **结构化错误 + i18n**：AppError + writeLocalizedError 体系让错误信息在前端可本地化
