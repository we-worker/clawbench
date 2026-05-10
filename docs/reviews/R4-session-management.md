# R4: Session 管理 Review

> 日期: 2026-05-10
> 审查范围: Session CRUD → SQLite持久化 → 运行时跟踪 → 取消/原因追踪

## 审查范围

### 前端
- `web/src/components/session/SessionDrawer.vue` (520行) — Session列表BottomSheet，含Agent选择器Modal
- `web/src/components/session/SessionSelector.vue` (225行) — 简化版Session选择器（备选/遗留）
- `web/src/composables/useSessionIdentity.ts` (227行) — 模块级单例，Session身份状态 + 动作代理
- `web/src/composables/useSessionManager.ts` (242行) — 统一Session操作协调层，含消息队列管理
- `web/src/composables/useSwipeSession.ts` (157行) — 滑动手势Session切换，含3秒缓存

### 后端API
- `internal/handler/chat_session.go` (149行) — Session CRUD端点（GET列表/POST创建/DELETE删除）
- `internal/handler/chat.go` (1025行) — Chat核心处理器，含auto-create/cancel/流式执行/队列drain
- `internal/handler/chat_history.go` (130行) — Chat历史CRUD端点

### 后端服务
- `internal/service/chat.go` (564行) — Session持久化、消息CRUD、软删除、RAG索引、清理
- `internal/service/session_runtime.go` (174行) — 运行时Session跟踪、流通道、取消原因追踪
- `internal/service/database.go` (432行) — SQLite初始化、Schema、孤儿流消息清理、快速命令

### 数据层
- `internal/model/chat.go` (55行) — ChatMessage、ChatSession、QueuedMessage、ContentBlock模型

## 三维度评估

### 🏗️ 架构设计 (30%)

**分层清晰，职责边界良好：**
整体遵循 Handler → Service → Model 三层架构，Handler负责HTTP解析/响应，Service负责业务逻辑，Model定义数据结构。Session运行时状态（`session_runtime.go`）与持久化（`chat.go`）分离合理。

**前端单例 + 代理模式设计精巧：**
`useSessionIdentity` 采用模块级单例管理全局Session身份，通过 `_switchSession`/`_createSession` 等回调代理实现控制反转 — 单例拥有身份状态，ChatPanel拥有操作实现。这解决了"多处需要Session信息但只有ChatPanel能执行操作"的矛盾。

**SessionManager作为协调层价值明确：**
`useSessionManager` 不拥有 `useChatSession`/`useChatStream`，而是接收它们的函数并包装，确保每次Session操作都经过 `cleanupActiveStream()` + 队列同步。这种薄协调层模式避免了遗漏清理步骤。

**存在的问题：**

1. **SessionDrawer与SessionSelector功能重叠** — SessionSelector.vue 是简化版（无删除、无Agent选择、无运行状态），与SessionDrawer共存但缺少明确的使用场景区分。代码重复（`loadSessions`、`formatRelativeTime`、Session列表渲染）。

2. **auto-create逻辑散布三处** — `AIChat GET`（:82-108）、`AIChat POST`（:157-180）、`ServeChatHistory GET`（:20-46）都有"若无Session则自动创建"的逻辑，三处实现略有差异但核心相同，违反DRY。

3. **`chat.go` 职责过重** — 1025行文件同时包含：HTTP路由处理、流执行循环、队列drain、resume_split处理、ask-question转换、工具函数。`executeStreamRun`+`finalizeStreamRun` 本身应属于Service层，而非Handler层。

4. **前端 `useSessionIdentity` 回调为null时静默失败** — `switchSession` 和 `deleteSession` 在 `_switchSession`/`_deleteSession` 为null时直接return，调用者无法区分"操作未执行"和"操作成功"。而 `createSession` 和 `sendMessage` 有fallback API调用，行为不一致。

5. **Cookie与查询参数双通道Session ID** — `getSessionID` 同时支持cookie和query param，但cookie `HttpOnly: false` 且无签名，存在CSRF/XSS窃取风险。

### ✨ 代码质量 (30%)

**命名和注释整体优秀：**
- `useSessionIdentity.ts` 的模块级注释清晰地解释了单例设计意图和所有权模型
- `useSessionManager.ts` 的JSDoc说明了"不拥有ChatSession/ChatStream"的设计决策
- 后端 `finalizeStreamRun` 的注释明确声明"不发送终端SSE事件"

**错误处理不均匀：**
- 后端使用 `model.WriteError` / `writeLocalizedErrorf` 结构化错误，但前端 `SessionDrawer.loadSessions` 只 `console.error`，用户无感知
- `useSessionIdentity.createSession` fallback路径在API失败时静默忽略（:144-146），与 `sendMessage` 的 `console.error` 处理不一致
- `service/chat.go` 多处 `DB.Exec` 的error被忽略（如 `UpdateLastRead` :287、`tx.Exec` 结果的 `LastInsertId` :200）

**代码重复：**

1. **前端 `fetch('/api/ai/sessions')`** 在 SessionDrawer(:156)、SessionSelector(:38)、useSwipeSession(:38) 三处重复，响应解析逻辑相同
2. **后端 auto-create** 三处重复（见架构部分）
3. **SessionDrawer `openAgentSelector` 和 `handleCreateClick`** 函数体几乎相同（:126-148），仅调用入口不同

**类型安全：**
- `useSessionManager` 的 `messages: Ref<any[]>` 和 `pendingMessages: ref([])` 缺乏类型约束
- `sessionCancelReasons` 的值类型断言 `val.(string)` (:74) 在类型不匹配时会panic
- `ContentBlock.Input` 使用 `map[string]any` 而非结构化类型，前端需做大量运行时类型检查

**其他：**
- `min()` 函数（chat.go:828-833）已由Go 1.21内置 `min` 提供，属冗余定义
- `convertAskQuestionBlocks` 中正则每次调用都重新编译（:858, :886, :893），应预编译为包级变量
- `deleteSession` 中 `setTimeout(() => loadSessions(), 300)` 的硬编码300ms延迟是脆弱的时序耦合

### 🛡️ 健壮性 (40%)

**并发安全 — 核心关注点：**

1. **P0: `activeSessions` map 与 `sessionStreams`/`sessionCancels` sync.Map 之间缺少原子性保证**
   - `TrySetSessionRunning` 加锁设置 `activeSessions[sessionID]=true`，但 `RegisterSessionStream`（:132-136）在锁外操作 `sessionStreams`。如果在 `TrySetSessionRunning` 成功后、`RegisterSessionStream` 之前发生崩溃，Session标记为running但没有stream channel，后续SSE连接无法找到stream
   - **实际风险**：chat.go:305在goroutine外注册stream，goroutine内(:330) `defer UnregisterSessionStream`。但如果 `RegisterSessionStream` 和goroutine launch之间发生panic（理论上不太可能但非零风险），stream泄漏
   - **缓解**：goroutine的 `defer SetSessionRunning(false)` 和 `defer UnregisterSessionStream` 在大多数场景覆盖了清理

2. **P1: `CancelSession` 中的TOCTOU竞态** — `sessionCancels.LoadAndDelete` 后立即 `SetSessionRunning(false)`(:111)，但AI goroutine的 `defer SetSessionRunning(false)` 也会执行。两次 `SetSessionRunning(false)` 本身安全（delete from map是幂等的），但 `CancelSession` 发送 `cancelled` SSE事件(:103)可能与AI goroutine的 `sendFinalEvent` 产生双重终端事件
   - **实际影响**：前端可能收到两个 `cancelled` 事件，但SSE处理一般是幂等的
   - **根因**：取消和正常结束的清理路径有重叠，缺乏状态机约束

3. **P1: 队列drain的竞态窗口** — chat.go:371 `time.Sleep(50ms)` 用于"re-check for enqueue-during-exit race"，这是经典的竞态修补。50ms窗口内如果用户恰好enqueue，消息可能被drain loop获取并执行，同时新的SSE连接也可能开始处理同一个session
   - **缓解**：`TrySetSessionRunning` 的原子性保证同一session只有一个活跃goroutine，所以实际风险较低

4. **P2: `sessionCancelReasons` 的 `LoadAndDelete` 原子性** — `GetAndClearCancelReason`(:69) 使用 `LoadAndDelete`，这是原子的。但如果在 `LoadAndDelete` 和 `Store`（:95）之间有并发调用，reason可能被覆盖。在当前使用场景下（同一session同时只有一个cancel路径），风险极低

**资源泄漏：**

5. **P1: `ForceCancelSession` 不调用 `SetSessionRunning(false)` 且不 `UnregisterSessionStream`**
   - `ForceCancelSession`(:119-129) 只做 `LoadAndDelete` cancel + cancel()，不清理 `activeSessions` 和 `sessionStreams`
   - 依赖AI goroutine的defer来清理，但如果goroutine已经卡死（cancel不生效），Session将永远标记为running，stream channel永远不关闭
   - **影响**：`IsSessionRunning` 永远返回true，新消息会被enqueue而非执行，Session实际上不可用

6. **P2: Stream channel容量64可能不足** — `RegisterSessionStream` 创建 `make(chan ai.StreamEvent, 64)`。如果SSE客户端慢（移动网络），AI事件产生速度 > 消费速度，channel满后事件被drop（`sendEvent` default分支）。虽然DB持久化保证数据不丢失，但SSE客户端会看到不完整的流

7. **P2: `useSwipeSession` 的sessionCache没有失效机制** — 缓存3秒TTL(:15)，但如果用户在3秒内删除了一个Session，滑动切换可能尝试切换到已删除的Session ID
   - **影响**：`switchSession` 会收到404，但前端未处理此错误场景

**边界条件：**

8. **P1: `DeleteSession` 不检查Session是否正在运行** — 后端 `DeleteSession`(handler :97-124) 直接软删除，不检查 `IsSessionRunning`。如果AI正在生成，Session被软删除后：
   - AI goroutine的 `FinalizeStreamingMessage` 会失败（Session已被标记deleted，但 `AddChatMessage` 有deleted守卫）
   - `AddChatMessage`(:136-140) 会拒绝插入到deleted session，但AI goroutine还在运行
   - **影响**：正在运行的AI消息可能丢失（无法持久化），但goroutine继续运行直到自行结束或超时
   - **前端缓解**：`useSessionManager.deleteSession` 先调用 `cleanupActiveStream()`，这会断开SSE连接触发 `ForceCancelSession`，但在网络延迟下可能存在窗口

9. **P2: `GetStreamingMessageID` 查询 `streaming=0 ORDER BY id DESC LIMIT 1`** — 在finalize后立即调用（:537, :700），如果同一个session有多个连续的assistant消息，可能返回错误的消息ID。正常流程中streaming消息在finalize后应只有一条，但在resume_split场景下可能有连续finalize

10. **P2: `FinalizeStreamingMessage` 匹配 `streaming=1`** — 如果同一session有多条streaming消息（理论上不应发生，但无约束），会批量finalize所有streaming消息

11. **P3: `SessionDrawer.deleteSession` 使用 `setTimeout(300ms)` 重载列表** — 如果删除API在300ms内未完成，列表显示过期数据；如果删除失败，列表仍显示已删除Session直到下次手动打开

**安全：**

12. **P1: Cookie `HttpOnly: false`** — `setSessionID`(:139-148) 设置 `chat_session_id` cookie时 `HttpOnly: false`，允许JavaScript读取Session ID。结合 `SameSite: Lax`，在XSS场景下Session ID可被窃取
    - **缓解**：Session ID不是认证凭证（认证靠password cookie），仅用于关联当前聊天

13. **P2: `DeleteSession` 不验证projectPath归属** — handler获取projectPath from cookie(:98-99)，但不验证被删除的sessionID是否属于该projectPath。service层 `DeleteSession`(chat.go:337-346) 的WHERE条件包含projectPath，所以SQL层面是安全的，但错误响应可能暴露其他project的session存在性（404 vs 200）

**前端健壮性：**

14. **P2: `useSessionIdentity` 的fallback `createSession` 引用了未导入的 `agents`** — :139行 `agents.getDefaultModelId(currentAgentId.value)` 引用了 `agents` 变量，但该变量只在 `initSessionFromAPI` 函数的闭包内(:63)定义，不在 `createSession` 的作用域中。这会导致运行时ReferenceError
    - **实际检查**：再看一遍代码... :63 `const agents = useAgents()` 是 `initSessionFromAPI` 的局部变量，而:139在 `createSession` 函数内，确实无法访问。**这是一个Bug**

15. **P2: `useSwipeSession.swipeToNext/swipeToPrev` 中 `sessionIndex` 可能与实际位置不同步** — `sessionIndex.value = nextIdx`(:73, :85) 假设 `sessions` 列表顺序与当前缓存一致，但如果缓存过期（>3秒），实际位置可能不同

16. **P3: `SessionDrawer` 的 `runningSessionIds` prop类型为 `Set`** — Vue的prop类型系统对 `Set` 的支持有限，`default: () => new Set()` 可能在某些场景下不触发响应式更新

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R4-001 | P0 | 健壮性 | `useSessionIdentity.createSession` fallback路径引用 `initSessionFromAPI` 闭包内的局部变量 `agents`，导致运行时ReferenceError | `useSessionIdentity.ts:139` | 将 `agents` 提取为模块级变量或在 `createSession` 内重新调用 `useAgents()` |
| R4-002 | P1 | 健壮性 | `ForceCancelSession` 不清理 `activeSessions` 和 `sessionStreams`，若AI goroutine卡死则Session永远标记为running | `session_runtime.go:119-129` | 添加 `SetSessionRunning(sessionID, false)` 和 `UnregisterSessionStream(sessionID)` 调用，或在 `ForceCancelSession` 后设置超时清理 |
| R4-003 | P1 | 健壮性 | `DeleteSession` 不检查Session是否正在运行，软删除后AI goroutine无法持久化消息 | `chat_session.go:97-124` | 在handler层增加running检查，若running则先cancel再delete |
| R4-004 | P1 | 健壮性 | `CancelSession` 可能产生双重终端SSE事件（CancelSession发送cancelled + AI goroutine的defer也发送） | `chat.go:348-351`, `session_runtime.go:99-108` | 引入状态标记或使用 `sync.Once` 保证只发送一次终端事件 |
| R4-005 | P1 | 安全 | Cookie `HttpOnly: false`，XSS可窃取Session ID | `chat_session.go:146` | 评估是否可以设为 `HttpOnly: true`，前端改用其他方式传递Session ID |
| R4-006 | P1 | 架构 | auto-create逻辑在3处重复（AIChat GET/POST、ServeChatHistory GET），实现略有差异 | `chat.go:82-108,157-180`, `chat_history.go:20-46` | 提取为 `getOrCreateSession` helper函数 |
| R4-007 | P2 | 架构 | `chat.go` 职责过重（1025行），流执行和队列逻辑应属Service层 | `chat.go` | 将 `executeStreamRun`、`finalizeStreamRun`、drain loop移至Service层 |
| R4-008 | P2 | 架构 | `SessionDrawer.vue` 与 `SessionSelector.vue` 功能重叠，代码重复 | `SessionDrawer.vue`, `SessionSelector.vue` | 确认 `SessionSelector` 是否仍在使用，如无则移除 |
| R4-009 | P2 | 质量 | `openAgentSelector` 和 `handleCreateClick` 函数体几乎完全相同 | `SessionDrawer.vue:126-148` | 提取为共享的 `showAgentDialog()` 方法 |
| R4-010 | P2 | 质量 | `convertAskQuestionBlocks` 中正则每次调用重新编译 | `chat.go:858,886,893` | 预编译为包级 `var` |
| R4-011 | P2 | 质量 | `min()` 函数冗余（Go 1.21+内置） | `chat.go:828-833` | 删除，使用内置 `min` |
| R4-012 | P2 | 健壮性 | 队列drain竞态窗口用 `time.Sleep(50ms)` 修补 | `chat.go:371` | 考虑使用channel信号或原子计数器替代sleep |
| R4-013 | P2 | 健壮性 | `useSwipeSession` 缓存过期后可能切换到已删除Session | `useSwipeSession.ts:14-15` | 在 `switchSession` 返回404时清除缓存并重试 |
| R4-014 | P2 | 健壮性 | `GetStreamingMessageID` 在resume_split后可能返回错误消息ID | `chat.go:406-416` | 添加 `streaming=0 AND id > lastFinalizedID` 条件，或在 `FinalizeStreamingMessage` 中返回消息ID |
| R4-015 | P2 | 质量 | `deleteSession` 用 `setTimeout(300ms)` 重载列表，时序耦合 | `SessionDrawer.vue:190` | 改为await删除API完成后重载，或监听事件驱动更新 |
| R4-016 | P2 | 健壮性 | Stream channel容量64在慢网络下可能不足 | `session_runtime.go:133` | 考虑增大到128，或实现动态背压机制 |
| R4-017 | P2 | 质量 | 前端 `fetch('/api/ai/sessions')` 在三处重复 | `SessionDrawer.vue:156`, `SessionSelector.vue:38`, `useSwipeSession.ts:38` | 提取为共享的 `fetchSessions()` 工具函数 |
| R4-018 | P2 | 健壮性 | `useSessionIdentity` 的 `switchSession`/`deleteSession` 在回调为null时静默失败 | `useSessionIdentity.ts:110-113,152-155` | 添加日志warning或返回boolean表示是否执行 |
| R4-019 | P2 | 质量 | `sessionCancelReasons` 的类型断言 `val.(string)` 无安全检查 | `session_runtime.go:74` | 使用 `val.(string)` 前检查ok，或使用typed wrapper |
| R4-020 | P3 | 健壮性 | `FinalizeStreamingMessage` 匹配 `streaming=1` 可能批量finalize多条消息 | `chat.go:396-402` | 添加 `ORDER BY id DESC LIMIT 1` 或唯一约束 |
| R4-021 | P3 | 质量 | `UpdateLastRead` 忽略error | `chat.go:287` | 至少记录日志 |
| R4-022 | P3 | 健壮性 | `SessionDrawer` 的 `runningSessionIds` prop使用 `Set` 类型，Vue响应式支持有限 | `SessionDrawer.vue:93` | 改用响应式的 `Array` 或 `Map` |
| R4-023 | P3 | 质量 | `DeleteSession` handler的 `backend` 默认值 `"codebuddy"` 硬编码 | `chat_session.go:113-115` | 从session记录中查询backend而非硬编码默认值 |

## 改进建议 (Top 3)

1. **修复 `useSessionIdentity.createSession` 的 `agents` 闭包Bug (R4-001)**: 将 `useAgents()` 调用从 `initSessionFromAPI` 局部变量提升为模块级变量。这是唯一一个P0级运行时Bug，会导致ChatPanel未挂载时的fallback创建Session路径崩溃。 — 预期收益: 消除生产环境功能性Bug

2. **增强 `ForceCancelSession` 的清理保证 (R4-002)**: 在 `ForceCancelSession` 中添加 `SetSessionRunning(false)` + `UnregisterSessionStream(sessionID)` + 超时清理机制（如5秒后强制清理），防止僵尸Session。同时考虑在 `CancelSession` 中引入状态标记避免双重终端事件(R4-004)。 — 预期收益: 消除Session永久卡死的风险，提升移动端断线恢复的可靠性

3. **提取auto-create为共享函数并增加DeleteSession的running检查 (R4-003, R4-006)**: 将三处auto-create逻辑统一为 `getOrCreateSession(w, r, projectPath)` helper，并在 `DeleteSession` handler中添加 `IsSessionRunning` 检查 — 若running则先cancel再delete。 — 预期收益: 消除代码重复和微小行为差异，防止删除正在运行的Session导致消息丢失

## 亮点

- **`useSessionIdentity` 的控制反转设计** — 单例拥有身份refs、ChatPanel拥有操作实现、通过回调代理桥接 — 优雅地解决了"全局需要状态但局部拥有操作"的设计矛盾
- **`useSessionManager` 的薄协调层** — 不拥有ChatSession/ChatStream而是包装其函数，确保cleanup + queue sync的一致性，避免了每个调用点都需记住清理步骤
- **`TrySetSessionRunning` 的原子check-and-set** — 使用mutex保护的原子操作防止同一Session的并发执行，是并发安全的基础保障
- **流消息的增量持久化** — 每5个事件或每1秒flush到DB（chat.go:581-598），在crash时最多丢失1秒数据，兼顾性能和可靠性
- **孤儿流消息的启动清理** — `InitDB` 在server启动时将 `streaming=1` 的消息标记为cancelled（database.go:177-224），避免了永久卡在streaming状态的消息
- **软删除 + 保留期清理** — 删除Session不立即物理删除，保留90天供RAG搜索，由CleanupWorker异步清理，兼顾数据安全和搜索需求
- **`sendEvent` 的非阻塞设计** — channel满时drop事件而非阻塞，DB持久化保证数据不丢失，避免SSE慢客户端拖垮AI goroutine
- **`agentSelectorOpenTime` 的防误触** — 400ms窗口防止触摸事件穿透到新弹出的对话框，体现移动端体验细节
