# R2: SSE 流式传输 Review

> 日期: 2026-05-09 (重新审查)
> 审查范围: SSE连接 → 事件解析 → 断线重连 → 超时 → Block合并 → 渲染

## 审查范围

### 前端
- `web/src/composables/useChatStream.ts` (1-534) — SSE连接、事件解析、断线重连、超时
- `web/src/composables/useChatRender.ts` (1-429) — Block合并、内容渲染
- `web/src/composables/useChatSession.ts` (1-538) — 连接/断开编排
- `web/src/composables/useSessionIdentity.ts` (1-226) — 运行状态追踪

### 后端
- `internal/handler/chat_stream.go` (1-179) — SSE中继
- `internal/service/session_runtime.go` (1-173) — 运行时管理
- `internal/ai/accumulate.go` (1-87) — 块累加
- `internal/ai/interface.go` (1-109) — StreamEvent 类型定义

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.8/10

**层次边界：**
- 前端 SSE 三层降级架构设计合理：EventSource 重连(3次) → HTTP 轮询(2s) → 全局会话轮询
- 后端 SSE 中继层（chat_stream.go）职责单一：仅做 EventSource 事件格式化 + channel 转发
- `accumulate.go` 作为纯函数实现 Block 合并逻辑，无副作用，可独立测试

**前后端 Block 合并同构：**
- 后端 `AccumulateBlock` 和前端 `parseMessages` 使用完全相同的合并规则（text/thinking 向后查找同类型 block + tool_use 边界 + ID 去重），确保 SSE 事件和 DB 快照解析结果一致
- 这是一个关键设计决策：重连后从 DB 加载历史消息，与之前 SSE 实时构建的状态必须等价

**断连不杀 session：**
- SSE 客户端断连后，后端通过 `ForceCancelSession(reason="disconnect")` 取消 CLI 进程，但 session 本身保留
- 前端重连时通过 `onLoadHistory()` 获取 DB 快照，再通过 SSE 继续接收新事件

**关注点：**
- `useChatStream` 同时承担 SSE 连接管理 + 事件解析 + 状态更新（修改 messages ref），职责略重（534行）
- `chat_stream.go` 的 `streamEventsToSSE` 函数既是事件格式化器又负责 context 监控，混合了协议层和应用层关注点

### ✨ 代码质量 (30%) — 评分: 7.3/10

**设计亮点：**
- `connectStream` 的 guard 闭包设计：通过捕获 `currentSessionId` 快照，确保只有当前 session 的事件才被处理，旧 session 的事件被安全丢弃
- 流超时重置机制：每个 SSE 事件都调用 `resetStreamTimeout()`，60s 无事件触发重连
- `handleVisibilityChange` 在页面重新可见时主动重连，覆盖移动端切回 app 场景

**代码重复：**
- SSE 事件处理中 `JSON.parse` + guard 检查 + `resetStreamTimeout` 模式在每个事件处理器中重复，约 10 个事件类型 × 3 行 = 30 行机械重复
- `onLoadHistory` 在 `useChatStream` 和 `useChatSession` 中都有实现，逻辑略有差异

**错误处理：**
- SSE 事件 `JSON.parse` 缺少 try-catch — 8 处无防护调用，畸形 JSON 会抛异常杀死整个事件监听器
- error 事件中二次 `JSON.parse(e.data)` 同样缺少防护
- 重连失败时降级到轮询的路径正确，但降级决策点不够清晰

### 🛡️ 健壮性 (40%) — 评分: 6.5/10

**SSE 事件解析脆弱性：**
- `useChatStream.ts` 中 8 处 `JSON.parse` 无 try-catch 防护（行 247,263,277,331,386,402,436,472）
- 任何一处解析异常都会杀死 EventSource 事件监听器，导致所有后续事件被静默丢弃
- 前端表现为"卡住"——AI 仍在运行但 UI 不再更新

**终态事件竞态：**
- `done`/`cancelled` 终态事件在 channel 满时被 drop，SSE handler 可能发送错误的终态类型
- `checkTicker` 与 defer 顺序竞态：`SetSessionRunning(false)` 在 `UnregisterSessionStream` 之前执行，可能导致 premature `cancelled`
- Channel close 始终 emit `done`，混淆了正常完成和 ForceCancel 的语义

**重连后事件丢失：**
- AI 完成后重连时，可能收到 `error` 而非 `done`——AI goroutine 可能在断连窗口中已发出 `done`
- 重连后 `onLoadHistory` 获取 DB 快照，但快照到新 SSE 连接之间的事件可能丢失

**channel 事件丢失：**
- `SendSessionEvent` 使用 `select + default` 非阻塞发送，channel 满时 drop event + log warning，但返回 `true`
- `CancelSession` 的非阻塞 `cancelled` 事件可能被 drop，前端不知道 session 已被取消

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R2-001 | **P0** | 🛡️ 健壮性 | JSON.parse 无 try-catch：8 处 SSE 事件解析无防护，畸形数据杀死整个事件监听器 | `useChatStream.ts:247,263,277,331,386,402,436,472` | 包裹 try-catch，失败时 log 并跳过 |
| R2-002 | **P0** | 🛡️ 健壮性 | `done`/`cancelled` 终态事件在 channel 满时被 drop，SSE handler 可能发送错误终态类型 | `session_runtime.go:162-173`, `chat.go:1016-1024` | 增大 channel buffer 或终态事件使用阻塞发送 |
| R2-003 | **P0** | 🛡️ 健壮性 | AI 完成后重连收到 `error` 而非 `done`：AI goroutine 可能在断连窗口中已发出 `done` | `useChatStream.ts:488-501`, `chat_stream.go:39-46` | 重连后检查 session running 状态，若已结束则发 done |
| R2-004 | **P0** | 🛡️ 健壮性 | `checkTicker` 与 defer 顺序竞态：`SetSessionRunning(false)` 在 `UnregisterSessionStream` 之前，premature `cancelled` | `chat_stream.go:158-165` | 调整 defer 顺序：先 Unregister 再 SetRunning |
| R2-005 | **P0** | 🛡️ 健壮性 | Channel close 始终 emit `done`，混淆正常完成和 ForceCancel 语义 | `chat_stream.go:67-73` | 区分 close 原因，ForceCancel 时 emit `cancelled` |
| R2-006 | **P0** | 🛡️ 健壮性 | `SendSessionEvent` 静默 drop 事件但 `sendEvent` 返回 true，调用方误以为投递成功 | `session_runtime.go:162-173` | drop 时返回 false，或终态事件使用阻塞发送 |
| R2-007 | **P0** | 🛡️ 健壮性 | `CancelSession` 非阻塞 `cancelled` 事件可能被 drop，前端不知道 session 已被取消 | `session_runtime.go:99-108` | cancelled 事件使用阻塞发送或重试 |
| R2-008 | **P1** | 🛡️ 健壮性 | `lastIndex` 闭包捕获 `queue_consume` 后的陈旧索引 | `useChatStream.ts:201,423` | 改为动态查找 |
| R2-009 | **P1** | 🛡️ 健壮性 | `warning` handler 引用未定义的 `streamingText` 字段 | `useChatStream.ts:389-391` | 修正为正确字段引用 |
| R2-010 | **P1** | ✨ 质量 | `reconnectAttempts` 在每次 `connectStream` 调用时重置，实际为 per-reconnect-cycle 而非 per-connection | `useChatStream.ts:198` | 在外层重置，connectStream 内递增 |
| R2-011 | **P1** | 🛡️ 健壮性 | `ForceCancelSession` 不调用 `SetSessionRunning(false)` | `session_runtime.go:119-129` | 添加 `SetSessionRunning(false)` 调用 |
| R2-012 | **P1** | 🛡️ 竞态 | `IsSessionRunning` 与 `GetSessionStream` 之间的 TOCTOU 竞态 | `session_runtime.go:13-17` | 合并为原子操作或在同一锁下检查 |
| R2-013 | **P1** | 🛡️ 健壮性 | `AccumulateBlock` 在 done 事件无 input 时将 tool_use input 替换为空 map，与前端逻辑不一致 | `accumulate.go:64-69` | 仅在 input 为零值时填充，不覆盖已有 input |
| R2-014 | **P1** | 🛡️ 健壮性 | 无服务端 SSE 心跳，长空闲期间前端无法区分挂起与无输出 | `chat_stream.go` 全文件 | 添加 15-30s 间隔的 SSE heartbeat comment |
| R2-015 | **P2** | ✨ 质量 | `TOOL_USE_TIMEOUT_MS` 硬编码魔数 | `useChatStream.ts` | 提取为命名常量集中管理 |
| R2-016 | **P2** | 🛡️ 健壮性 | `forceCleanupStreamingState` 不调用 `onStreamEnd`，streaming 状态可能残留 | `useChatStream.ts` | 添加 onStreamEnd 调用 |
| R2-017 | **P2** | ✨ 质量 | Content-Type 缺少 charset=utf-8 | `chat_stream.go:34` | 改为 `text/event-stream; charset=utf-8` |
| R2-018 | **P2** | ✨ 质量 | error 事件用 `%q` 而非 `json.Marshal` 序列化 | `chat_stream.go:41` | 使用 `json.Marshal` 保持一致性 |
| R2-019 | **P2** | ✨ 质量 | error 类型存储为 warning ContentBlock，语义偏差 | `accumulate.go:85` | 添加注释说明设计意图或引入 error block 类型 |
| R2-020 | **P2** | ✨ 质量 | StreamEvent.Type 为无类型字符串，事件类型 switch 无 exhaustive 检查 | `interface.go:71` | 定义 `EventType` 常量类型 |
| R2-021 | **P2** | ✨ 质量 | `parseAssistantContent` 中静默 catch 异常 | `useChatRender.ts:251` | 至少 log warning |

---

## 改进建议 (Top 3)

1. **修复 JSON.parse try-catch + channel close/write 竞态 (R2-001 + R2-004 + R2-005)**: 这三个 P0 问题是 SSE 流式传输最严重的健壮性缺陷。`JSON.parse` 无防护可导致整个 SSE stream 崩溃，8 处调用全部暴露；defer 顺序导致 premature `cancelled`；channel close 不区分完成/取消语义。建议：所有 SSE 事件处理中 `JSON.parse` 包裹 try-catch，失败时 log 并跳过；调整 defer 顺序为先 `UnregisterSessionStream` 再 `SetSessionRunning(false)`；channel close 时根据 cancel reason emit 对应终态事件。预期收益：消除生产崩溃级 bug 和前端 stream 崩溃，终态事件语义正确。

2. **添加服务端 SSE 心跳 + 增大终态事件 channel buffer (R2-014 + R2-002)**: 当前无服务端心跳，长空闲期间前端无法区分服务端挂起和正常无输出；终态事件在 channel 满时被 drop，前端可能永远收不到 `done`。建议：在 `streamEventsToSSE` 中添加 15-30s 间隔的 SSE heartbeat comment（`: heartbeat\n\n`），绕过 sessionStreams channel 直接写入 HTTP response writer；增大 channel buffer 或对终态事件使用阻塞发送。预期收益：消除长空闲误超时，确保终态事件可靠投递。

3. **修复 AccumulateBlock tool_use input 替换分歧 (R2-013)**: 后端 `AccumulateBlock` 在 done 事件无 input 时将 tool_use input 替换为空 map `{}`，而前端保留了流式阶段收到的 input。这导致 DB 中存储的内容与前端渲染不一致，重连后从 DB 加载时 input 消失。建议：仅在 input 为零值（nil）时填充空 map，不覆盖流式阶段已收到的 input。预期收益：消除前后端 Block 合并的语义分歧，确保重连后 DB 快照与 SSE 实时构建状态等价。

---

## 亮点

- **前后端 Block 合并同构**：`AccumulateBlock` 和 `parseMessages` 使用完全相同的合并规则，确保 SSE 实时构建和 DB 快照加载的状态等价
- **断连不杀 session**：SSE 断连只取消 CLI 进程，session 保留，重连后可完整恢复
- **done 后强制 DB 重载**：streaming 结束时从 DB 重新加载完整消息，补偿了 channel drop 事件的影响
- **三层容错降级**：EventSource 重连 → HTTP 轮询 → 全局会话轮询，每层独立恢复
- **visibilitychange 主动重连**：覆盖移动端切回 app 场景
- **guard 闭包隔离**：通过捕获 sessionId 快照，确保旧 session 事件不会污染新 session
