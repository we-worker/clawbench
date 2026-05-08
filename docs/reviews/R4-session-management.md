# R4: Session 管理 Review

> 日期: 2026-05-09 (重新审查)
> 审查范围: Session CRUD → SQLite持久化 → 运行时跟踪 → 取消/原因追踪

## 审查范围

### 前端
- `web/src/components/session/SessionDrawer.vue` (1-490) — 任务列表抽屉
- `web/src/components/session/SessionSelector.vue` (1-224) — 会话选择器
- `web/src/composables/useSessionIdentity.ts` (1-226) — 会话身份单例
- `web/src/composables/useSessionManager.ts` (1-241) — 会话管理操作
- `web/src/composables/useSwipeSession.ts` (1-156) — 滑动切换会话
- `web/src/composables/useChatSession.ts` (1-538) — 连接/断开编排

### 后端
- `internal/handler/chat_session.go` (1-149) — Session API
- `internal/handler/chat.go` (1-1025) — auto-create/cancel
- `internal/handler/chat_history.go` (1-129) — 历史 API
- `internal/service/chat.go` (1-381) — 消息持久化
- `internal/service/session_runtime.go` (1-173) — 运行时管理
- `internal/service/database.go` (1-241) — 数据库 DDL
- `internal/model/chat.go` (1-51) — 数据模型

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.2/10

**useSessionIdentity 单例设计优秀：**
- 模块级 `ref` 实现跨组件状态共享，避免 prop drilling
- 控制反转设计：单例持有身份 refs（currentSessionId、isRunning），ChatPanel 注册操作回调（onSwitchSession、onCreateSession）
- 解决了 "单例拥有身份，ChatPanel 拥有操作" 的职责边界问题

**Session 生命周期清晰：**
- 前端：创建 → 切换 → 删除 → 自动创建（删除后无会话时）
- 后端：auto-create（GET/POST 无 session 时自动创建）→ running 跟踪 → cancel（user/disconnect）
- 软删除设计：`deleted=1` 标记保留数据供 RAG 搜索，`CleanupWorker` 定期清理过期数据

**关注点：**
- Session 自动创建逻辑在 4 个 handler 中重复，变量命名不一致
- `useSessionManager` 职责略重：同时管理创建/删除/切换 + unread 状态 + 滑动切换
- 后端 `session_runtime.go` 的 `activeSessions`/`sessionStreams`/`sessionCancels` 使用 `sync.Map`，全局可变状态难以测试

### ✨ 代码质量 (30%) — 评分: 7.5/10

**亮点：**
- `switchSessionSeq` 序列号竞态防护简洁有效
- Session cookie 的 `SameSite: Lax` 配置合理
- `useSwipeSession` 的触摸手势处理考虑了边缘情况（最小滑动距离、边界session）
- Cancel reason 追踪区分 "user"（主动取消）和 "disconnect"（SSE 断连），语义清晰

**关注点：**
- Session 相关的 API 调用散布在 5+ 个文件中，缺少统一的 API 封装
- `useSessionManager` 中 `createSession` 有两套路径（自动创建 vs 手动创建），逻辑略有差异
- 后端 `DeleteSession` 的两次 DELETE 不在同一事务内

### 🛡️ 健壮性 (40%) — 评分: 7.0/10

**CancelSession 竞态（与 R1-001 同源）：**
- `CancelSession` 与 AI goroutine 的 defer 对 `sessionStreams` 存在 close-after-write 竞态
- 在快速切换 session 场景下更明显：用户切走 → 旧 session 的 CancelSession → 新 session 的 AI goroutine 启动
- `SetSessionRunning(false)` 在 CancelSession 和 goroutine defer 中都被调用，虽然幂等但语义不清

**sessionQueues 并发操作：**
- `DeleteSession` 删除 session 时，如果对应的 AI goroutine 正在运行，`sessionQueues.Delete` 和 `DequeueMessage` 中的 `sessionQueues.Load` 可能交错
- 具体：`queue.go:84` `RemoveQueueItem` 删除后 items 为空则 `sessionQueues.Delete`，而 `DequeueMessage` L46-48 也做同样操作，两个入口并发可能导致一方拿到被删的 entry

**ForceCancelSession 不设 running 状态：**
- `ForceCancelSession`（`session_runtime.go:119-129`）不调用 `SetSessionRunning(false)`
- 后续 `IsSessionRunning` 检查仍返回 true，可能导致新的 AI 请求被误拒

**前端 deleteSession 后自动创建：**
- `useChatSession.ts:313-322` 删除后无会话时调用 `createSession()`
- 如果 `createSession` 失败，`currentSessionId` 可能指向已删除的 session

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R4-001 | **P0** | 🛡️ 竞态 | CancelSession 与 goroutine defer 的 close-after-write 竞态（与 R1-001 同源） | `session_runtime.go:99-113` | 引入 `streamClosed` atomic bool，`sendEvent` 检查后再发送 |
| R4-002 | **P1** | 🛡️ 竞态 | Dequeue/Enqueue 与 Delete 的 `sessionQueues` 并发操作 | `queue.go:84` + `queue.go:46-48` | 引入 `sessionQueueMu` 互斥锁保护 load/delete 操作 |
| R4-003 | **P1** | 🛡️ 健壮性 | deleteSession 后 createSession 失败时 currentSessionId 指向已删除 session | `useChatSession.ts:313-322` | createSession 失败时重置 currentSessionId |
| R4-004 | **P1** | 🛡️ 健壮性 | `SetSessionRunning(false)` 在 CancelSession 和 goroutine defer 都调用 | `session_runtime.go:111` | 使用 `sync.Once` 或 CAS 语义确保只执行一次 |
| R4-005 | **P1** | 🛡️ 健壮性 | `ForceCancelSession` 不调用 `SetSessionRunning(false)` | `session_runtime.go:119-129` | 添加 `SetSessionRunning(false)` 调用 |
| R4-006 | **P2** | 🏗️ 架构 | Session 自动创建逻辑重复 4 次（与 R1-009 同） | 多处 handler | 提取 `ensureSession()` 辅助函数 |
| R4-007 | **P2** | ✨ 质量 | Session API 调用散布在 5+ 文件，缺少统一封装 | 前端多文件 | 提取 `useSessionApi` composable |
| R4-008 | **P2** | 🛡️ 健壮性 | DeleteSession 两次 DELETE 不在同一事务（与 R1-019 同） | `chat.go:270-279` | 事务包裹两步 DELETE |
| R4-009 | **P2** | 🛡️ 安全 | Session cookie `HttpOnly: false`（与 R1-012 同） | `chat_session.go:145` | 设为 `HttpOnly: true` |
| R4-010 | **P2** | 🛡️ 健壮性 | useSwipeSession 边界检查不覆盖单 session 场景 | `useSwipeSession.ts:40-50` | 单 session 时禁用滑动或显示提示 |
| R4-011 | **P3** | ✨ 质量 | useSessionManager 中 createSession 两套路径逻辑略有差异 | `useSessionManager.ts` | 统一为单一 createSession 实现 |
| R4-012 | **P3** | ✨ 质量 | SessionDrawer 的 v-for 无 key 绑定 | `SessionDrawer.vue` 列表渲染 | 添加 `:key="session.id"` |

---

## 改进建议 (Top 3)

1. **修复 sessionQueues 并发操作竞态 (R4-002)**: `RemoveQueueItem` 和 `DequeueMessage` 都可能删除 `sessionQueues` 中的 entry，并发时一方可能操作已被删除的 entry。建议引入 `sessionQueueMu` 互斥锁，或在 `queue.go` 中统一通过 `getOrCreateEntry` 管理 entry 生命周期，确保 Dequeue 和 Delete 操作互斥。预期收益：消除消息丢失和 nil pointer panic 风险。

2. **提取 Session API 封装 (R4-007)**: Session 相关的 API 调用（create/delete/switch/list）散布在 5+ 个文件中，错误处理不一致，有些用 `fetch` 有些用 `apiGet`。建议提取 `useSessionApi` composable 统一封装所有 Session HTTP 调用，集中处理错误和认证。预期收益：减少重复代码，统一错误处理，降低维护成本。

3. **确保 deleteSession 原子性 (R4-003 + R4-008)**: 前端 deleteSession 后自动 createSession 失败时，`currentSessionId` 指向已删除 session，后续所有 API 调用将失败；后端两次 DELETE 不在同一事务，中间崩溃导致数据不一致。建议：前端 createSession 失败时重置 `currentSessionId` 为空并触发自动创建；后端用事务包裹两步 DELETE。预期收益：消除删除操作的边界 case，确保前后端状态一致。

---

## 亮点

- **useSessionIdentity 控制反转设计**：单例持有身份 refs，ChatPanel 注册操作回调，优雅解决 Vue composable 单例与组件生命周期冲突
- **switchSessionSeq 序列号竞态防护**：简洁的 `++switchSessionSeq` 方案，比 Promise cancellation 轻量
- **Orphaned streaming message 清理**：启动时自动将崩溃遗留的 streaming=1 消息标记为 cancelled
- **Cancel reason 追踪**：区分 "user"（主动取消）和 "disconnect"（SSE 断连），语义清晰
- **useSwipeSession 手势设计**：考虑了最小滑动距离和边界 session 场景
