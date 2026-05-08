# R1: Chat 主流程 Review

> 日期: 2026-05-09 (重新审查)
> 审查范围: 前端输入 → Handler → AI Backend → CLI → StreamParser → SSE → 前端渲染

## 审查范围

### 前端
- `web/src/components/chat/ChatInputBar.vue` (1-1170)
- `web/src/components/chat/ChatPanel.vue` (1-823)
- `web/src/composables/useChatSession.ts` (1-539)
- `web/src/composables/useChatStream.ts` (1-534)
- `web/src/composables/useChatRender.ts` (1-430)
- `web/src/composables/useSessionIdentity.ts` (1-227)
- `web/src/composables/useAutoSpeech.ts` (1-327)
- `web/src/composables/useFileUpload.ts` (1-167)
- `web/src/composables/useAgents.ts` (1-77)
- `web/src/composables/useQuoteQuestion.ts` (1-215)
- `web/src/utils/api.ts` (1-38)
- `web/src/components/chat/ChatMessageList.vue` (1-479)
- `web/src/components/chat/ChatMessageItem.vue` (1-856)
- `web/src/components/chat/ContentBlocks.vue` (1-1365)
- `web/src/components/chat/ChatMetadataModal.vue` (1-316)
- `web/src/composables/useMarkdownRenderer.ts` (1-177)
- `web/src/utils/renderToolDetail.ts` (1-617)

### 后端
- `internal/handler/handler.go` (1-217)
- `internal/handler/chat.go` (1-1025)
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
- `internal/ai/factory.go` (1-28)
- `internal/ai/cli_backend.go` (1-231)
- `internal/ai/stream_parser.go` (1-361)
- `internal/ai/accumulate.go` (1-88)

### 数据层
- SQLite via `internal/service/database.go`
- `chat_sessions` / `chat_history` / `chat_messages` 表

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.8/10

**层次边界：** Handler → Service → Model/DB 三层分离清晰。前端 ChatPanel → Composables → API 分层合理。但有几处越界：
- `handler.go` `resolveAgentConfig()` 直接读取 `model.Agents` 全局变量，Handler 层直接耦合了 Model 层的配置状态
- `handler/chat.go` AI goroutine 内调用了 `buildChatRequest()`，其中又调用 Service 逻辑
- `useChatRender` 的 `renderTextBlock` 中解析标签并修改响应式状态，属于副作用型渲染

**职责单一：** `chat.go` (1025行) 职责过重，同时承担 HTTP路由处理、AI goroutine生命周期、流事件累积/持久化。前端 `useChatSession` 同时包含session CRUD、消息轮询、全局轮询，职责过宽。

**接口设计：** `AIBackend` 接口精简（Name + ExecuteStream），`LineParser` 接口扩展性好。`CLIBackend` 用回调函数实现模板方法模式。前端 Composable 拆分合理，`useSessionIdentity` 的控制反转设计巧妙。

**耦合度：**
- Service 层重度依赖包级全局变量（`DB`, `activeSessions`, `sessionStreams`, `sessionCancels`）
- `messages` ref 在多处被直接修改，没有统一的状态管理层
- API调用风格不统一：`useChatSession`用裸`fetch`，`useAgents`用`apiGet`

**扩展性：** 新增 AI Backend 只需实现 `AIBackend`/`LineParser` + 在 `factory.go` 加 case + 注册 agent YAML。前端 `renderToolDetail.ts` 的注册表模式支持工具扩展零侵入。

### ✨ 代码质量 (30%) — 评分: 7.3/10

**设计模式：**
- `CLIBackend` 的回调组合模式 — 避免 5+ 个 Backend 子类的代码重复
- `AutoResumeBackend` 装饰器模式 — 透明包装 ExitPlanMode 逻辑
- `renderToolDetail.ts` 注册表模式 — 开放-封闭原则
- `useSessionIdentity` 控制反转 — 解决单例与组件生命周期冲突

**代码重复：**
- Session 自动创建逻辑在多个 handler 中重复，变量命名不一致
- `parseMessages` 逻辑在 `useChatSession` 和 `useChatStream` 中重复
- SSE 事件处理中 guard + resetTimeout + JSON.parse 模式重复约 30 行

**命名/注释：**
- 注释质量高，关键设计决策都有注释说明
- `streamRunResult.cancelReason` 用字符串而非枚举
- `useSessionIdentity.ts:139` `agents` 变量可能不在作用域内

**错误处理：**
- 结构化错误体系设计完善
- Handler 层存在两种错误响应路径并行
- SSE 事件 `JSON.parse` 无 try-catch 防护
- 前端 `resp.json()` 调用缺少 try-catch

**类型安全：**
- 前端核心数据结构 `messages: Ref<any[]>` 缺少接口定义
- `StreamEvent.Type` 是字符串，事件类型 switch 无 exhaustive 检查
- `window as any` 滥用（15+ 次）

### 🛡️ 健壮性 (40%) — 评分: 6.8/10

**竞态条件：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `session_runtime.go:99-113` + `chat.go:321` | `CancelSession` 与 goroutine defer 对 `sessionStreams` 存在 close-after-write 竞态 | **P0** |
| `useChatStream.ts:247,263,277,331,386,402,436` | SSE 事件 `JSON.parse` 无 try-catch，畸形数据导致整个 stream 崩溃 | **P0** |
| `useChatStream.ts:470-484` | error 事件中 `JSON.parse(e.data)` 也无防护 | **P0** |
| `useChatRender.ts:98` | `<audio src="${href}">` 注入未转义的 href，XSS 向量 | **P1** |
| `useChatStream.ts:401-433` | `queue_consume` 事件 push 后 `lastIndex` 闭包变量与实际数组不一致 | P1 |
| `useAutoSpeech.ts:189-215` | `es.onerror` 和 `result` 事件双重调用 `handleResult` | P1 |
| `useSessionIdentity.ts:139` | `agents` 变量在 `createSession` 回退路径中可能未定义 | P1 |

**资源泄漏：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `cli_backend.go:38` | `exec.CommandContext` SIGKILL 不传播到孙进程，产生孤儿进程 | **P1** |
| `useFileUpload.ts:31-33` | XHR 请求在组件卸载后不会 abort | P1 |
| `session_runtime.go:152-158` | `UnregisterSessionStream` close channel 后 goroutine 继续写会 panic | P1 |
| `useChatRender.ts:14-15` | `blockTasks` reactive 对象只增不减 | P2 |
| `ChatInputBar.vue:236` | `draftCache` Map 无大小限制，永不清理 | P2 |
| `useChatSession.ts:369-383` | `setInterval` 异步回调无并发保护 | P1 |

**边界条件：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `ChatInputBar.vue:99` | Enter 键不检查 `e.isComposing`，IME 中文输入时误发消息 | P1 |
| `useChatSession.ts:313-322` | `deleteSession` 后 `createSession()` 失败时状态不一致 | P1 |
| `useMarkdownRenderer.ts:146` | Mermaid `data-rendered` 在渲染前设置，失败后永久跳过 | P1 |
| `ContentBlocks.vue:87` | `|| true` 短路了 `expandedTools` 条件，代码意图不清晰 | P2 |

**安全漏洞：**

| 位置 | 描述 | 严重度 |
|------|------|--------|
| `useChatRender.ts:90-101` | DOMPurify 后注入 image/audio 标签，可能重新引入不安全属性 | P1 |
| `chat_session.go:145` | `HttpOnly: false` 的 session cookie 可被 XSS 窃取 | P2 |
| `handler.go:207` | `/api/ssh/info` 无需认证，暴露 SSH 端口和指纹 | P2 |

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R1-001 | **P0** | 🛡️ 健壮性 | `CancelSession` 与 goroutine defer 对 `sessionStreams` 存在 close-after-write 竞态 | `session_runtime.go:99-113` | 引入 `streamClosed` atomic bool，`sendEvent` 检查后再发送 |
| R1-002 | **P0** | 🛡️ 健壮性 | SSE 事件 `JSON.parse` 无 try-catch，畸形数据导致整个 stream 崩溃 | `useChatStream.ts:247,263,277,331,386,402,436` | 包裹 try-catch，失败时 log 并跳过 |
| R1-003 | **P0** | 🛡️ 健壮性 | error 事件中 `JSON.parse(e.data)` 也无防护 | `useChatStream.ts:470-484` | 包裹 try-catch |
| R1-004 | **P1** | 🛡️ 安全 | DOMPurify 后 audio 标签注入未转义 href | `useChatRender.ts:98` | 使用 `escapeHtml(href)` 或 DOM API 创建元素 |
| R1-005 | **P1** | 🛡️ 泄漏 | CLI 子进程的孙进程不被 SIGKILL 清理，产生孤儿进程 | `cli_backend.go:38` | 使用 `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` |
| R1-006 | **P1** | 🛡️ 健壮性 | `UnregisterSessionStream` close channel 后 goroutine 继续写会 panic | `session_runtime.go:152-158` | `sendEvent` 应 recover from panic 或用 atomic flag |
| R1-007 | **P1** | 🛡️ 竞态 | `queue_consume` 事件 push 后 `lastIndex` 闭包变量与实际数组不一致 | `useChatStream.ts:401-433` | 改为动态查找 |
| R1-008 | **P1** | 🛡️ 竞态 | `useAutoSpeech` 中 `es.onerror` 和 `result` 事件双重调用 `handleResult` | `useAutoSpeech.ts:189-215` | 添加 `resultHandled` 标志位 |
| R1-009 | **P1** | 🛡️ 泄漏 | `useFileUpload` 的 XHR 请求在组件卸载后不会 abort | `useFileUpload.ts:31-33` | 改用 `fetch` + `AbortController` |
| R1-010 | **P1** | 🛡️ 健壮性 | `deleteSession` 后 `createSession()` 失败时 `currentSessionId` 指向已删除会话 | `useChatSession.ts:313-322` | createSession 失败时重置 currentSessionId |
| R1-011 | **P1** | 🛡️ 健壮性 | Enter 键不检查 `e.isComposing`，IME 中文输入时误发消息 | `ChatInputBar.vue:99` | 添加 `if (e.isComposing) return` |
| R1-012 | **P1** | 🛡️ 健壮性 | `agents` 变量在 `createSession` 回退路径中可能未定义 | `useSessionIdentity.ts:139` | 在函数作用域内调用 `useAgents()` 或提取为参数 |
| R1-013 | **P1** | 🛡️ 健壮性 | `setInterval` 异步回调无并发保护，`loadHistory` 可重叠 | `useChatSession.ts:369-383` | 添加 `isLoading` 守卫 |
| R1-014 | **P1** | 🛡️ 健壮性 | Mermaid `data-rendered` 在渲染前设置，失败后永久跳过 | `useMarkdownRenderer.ts:146` | 渲染成功后再设置 |
| R1-015 | **P1** | ✨ 质量 | Session 自动创建逻辑重复，变量名不一致 | 多处 handler | 提取为 `ensureSession()` 辅助函数 |
| R1-016 | **P1** | ✨ 质量 | 错误响应存在两条路径并行：有/无 i18n | `chat.go` 多处 | 统一为 `writeLocalizedError` |
| R1-017 | **P2** | 🏗️ 架构 | `chat.go` 1025 行，职责过重 | `handler/chat.go` | 拆分：goroutine 逻辑提取为 `service/ai_executor.go` |
| R1-018 | **P2** | 🛡️ 安全 | `HttpOnly: false` 的 session cookie 可被 XSS 窃取 | `chat_session.go:145` | 设为 `HttpOnly: true` |
| R1-019 | **P2** | 🛡️ 安全 | `/api/ssh/info` 无需认证 | `handler.go:207` | 加 `middleware.Auth` 保护 |
| R1-020 | **P2** | 🛡️ 健壮性 | `AccumulateBlock` 的 `json.Unmarshal` 忽略错误 | `accumulate.go:60` | 至少 log warning |
| R1-021 | **P2** | 🛡️ 健壮性 | `SetSessionRunning(false)` 在 CancelSession 和 goroutine defer 都调用 | `session_runtime.go:111` | 使用 `sync.Once` 或 CAS 语义 |
| R1-022 | **P2** | 🛡️ 健壮性 | `blockTasks` reactive 对象只增不减 | `useChatRender.ts:14-15` | switchSession 时清除旧 key |
| R1-023 | **P2** | 🛡️ 健壮性 | `draftCache` Map 无大小限制 | `ChatInputBar.vue:236` | 添加 LRU 或大小上限 |
| R1-024 | **P2** | ✨ 质量 | `streamRunResult.cancelReason` 用字符串而非枚举 | `chat.go:403-407` | 定义 `type CancelReason int` 枚举 |
| R1-025 | **P2** | ✨ 质量 | `parseMessages` 逻辑重复 | `useChatSession.ts,useChatStream.ts` | 提取共享函数 |
| R1-026 | **P2** | ✨ 质量 | 核心数据结构缺少 TypeScript 接口定义 | 多文件 | 定义 ChatMessage、ContentBlock 等接口 |
| R1-027 | **P2** | ✨ 质量 | API 调用风格不统一 | `useChatSession.ts,ChatPanel.vue` | 统一使用 apiGet/apiPost |
| R1-028 | **P2** | ✨ 质量 | ContentBlocks.vue `|| true` 短路条件 | `ContentBlocks.vue:87` | 移除 `|| true`，使用 `shouldAutoExpand(block)` |
| R1-029 | **P2** | ✨ 质量 | SSE 事件处理器模式重复约 30 行 | `useChatStream.ts` 多处 | 提取 `handleSSEEvent(type, handler)` 高阶函数 |
| R1-030 | **P3** | ✨ 质量 | `ChatMetadataModal` 使用已废弃的 `document.execCommand('copy')` | `ChatMetadataModal.vue:117` | 改用 `navigator.clipboard.writeText` |
| R1-031 | **P3** | ✨ 质量 | CSS 中硬编码颜色值与 CSS 变量重复 | `ChatInputBar.vue` 多处 | 统一使用 CSS 变量 |

---

## 改进建议 (Top 3)

1. **修复 channel close/write 竞态 + SSE JSON.parse 防护 (R1-001+R1-002+R1-003)**: 这三个 P0 问题是 Chat 主流程最严重的健壮性缺陷。`CancelSession` 与 goroutine defer 的竞态可导致 send-on-closed-channel panic；JSON.parse 无防护可导致整个 SSE stream 崩溃。建议：引入 `streamClosed` atomic bool 标记，`sendEvent` 检查后再发送；所有 SSE 事件处理中 `JSON.parse` 包裹 try-catch。预期收益：消除生产崩溃级 bug 和前端 stream 崩溃。

2. **提取 SSE 事件处理高阶函数 (R1-029)**: 10+ 个事件处理器中 guard + resetTimeout + JSON.parse 模式机械重复。建议提取 `handleSSEEvent(eventType, handler)` 高阶函数，统一处理 guard 检查、超时重置、JSON 解析和错误处理。预期收益：减少 ~30 行重复代码，集中处理 JSON.parse 错误。

3. **拆分 chat.go + 提取 ensureSession (R1-017+R1-015)**: chat.go 1025 行职责过重，同时承担 HTTP路由处理、AI goroutine生命周期、流事件持久化。建议拆分为 `service/ai_executor.go`（goroutine 逻辑）和 `handler/chat_helpers.go`（辅助函数）。4 处重复的 session 自动创建逻辑提取为 `ensureSession()` 辅助函数。预期收益：chat.go 降至 ~400 行，消除重复代码，职责边界清晰。

---

## 亮点

- **AutoResumeBackend 装饰器模式**：透明包装 ExitPlanMode 逻辑，`resume_split` 事件设计巧妙
- **CLIBackend 回调组合模式**：5+ 个后端共享 CLI 执行框架，通过回调注入差异
- **useSessionIdentity 控制反转设计**：单例持有身份 refs，ChatPanel 注册操作回调
- **SSE 三层容错架构**：EventSource 重连(3次) → HTTP 轮询 → 全局会话轮询
- **renderToolDetail.ts 注册表模式**：工具扩展零侵入
- **switchSession 序列号竞态防护**：简洁的 `++switchSessionSeq` 方案
- **流式渲染节流**：ContentBlocks 的 `blockHtmlCache` + `THROTTLE_MS`
- **Orphaned streaming message 清理**：启动时自动将崩溃遗留的 streaming=1 消息标记为 cancelled
- **增量持久化策略**：每 5 个事件 + 每 1s ticker 双触发，SSE channel full 时 drop event 但 DB 已持久化
