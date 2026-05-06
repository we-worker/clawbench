# R2: SSE 流式传输 Review

> 日期: 2026-05-24
> 审查范围: SSE连接 → 事件解析 → 断线重连 → 超时 → Block合并 → 渲染

## 审查范围

### 前端
- `web/src/composables/useChatStream.ts` (1-536) — SSE连接、事件解析、断线重连、超时
- `web/src/composables/useChatRender.ts` (1-361) — Block合并、内容渲染
- `web/src/composables/useChatSession.ts` (1-513) — 连接/断开编排
- `web/src/composables/useSessionIdentity.ts` (1-212) — 运行状态追踪

### 后端
- `internal/handler/chat_stream.go` (1-179) — SSE中继
- `internal/service/session_runtime.go` (1-173) — 运行时管理
- `internal/ai/accumulate.go` (1-91) — 块累加
- `internal/ai/interface.go` (1-110) — StreamEvent 类型定义

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.0/10

**层次边界清晰：**
- 前端 SSE 三层降级架构设计合理：EventSource 重连(3次) → HTTP 轮询(2s) → 全局会话轮询
- 后端 SSE 中继层（chat_stream.go）职责单一：仅做 EventSource 事件格式化 + channel 转发
- `accumulate.go` 作为纯函数实现 Block 合并逻辑，无副作用，可独立测试

**前后端 Block 合并同构：**
- 后端 `AccumulateBlock` 和前端 `parseMessages` 使用完全相同的合并规则（text/thinking 向后查找同类型 block + tool_use 边界 + ID 去重），确保 SSE 事件和 DB 快照解析结果一致
- 这是一个关键设计决策：重连后从 DB 加载历史消息，与之前 SSE 实时构建的状态必须等价

**断连不杀 session：**
- SSE 客户端断连后，后端通过 `ForceCancelSession(reason="disconnect")` 取消 CLI 进程，但 session 本身保留
- 前端重连时通过 `onLoadHistory()` 获取 DB 快照，再通过 SSE 继续接收新事件
- 这个设计确保了短暂网络中断不会丢失上下文

**关注点：**
- `useChatStream` 同时承担 SSE 连接管理 + 事件解析 + 状态更新（修改 messages ref），职责略重（536行）
- `chat_stream.go` 的 `streamEventsToSSE` 函数既是事件格式化器又负责 context 监控 + 心跳，混合了协议层和应用层关注点

### ✨ 代码质量 (30%) — 评分: 7.5/10

**设计亮点：**
- `connectStream` 的 guard 闭包设计：通过捕获 `currentSessionId` 快照，确保只有当前 session 的事件才被处理，旧 session 的事件被安全丢弃
- 流超时重置机制：每个 SSE 事件都调用 `resetStreamTimeout()`，60s 无事件触发重连
- `handleVisibilityChange` 在页面重新可见时主动重连，覆盖移动端切回 app 场景

**代码重复：**
- SSE 事件处理中 `JSON.parse` + guard 检查 + `resetStreamTimeout` 模式在每个事件处理器中重复，约 10 个事件类型 × 3 行 = 30 行机械重复
- `onLoadHistory` 在 `useChatStream` 和 `useChatSession` 中都有实现，逻辑略有差异

**命名/注释：**
- 流式传输相关的常量分散在多处：`STREAM_TIMEOUT_MS` (useChatStream)、`TOOL_USE_TIMEOUT_MS` (useChatStream)、`THROTTLE_MS` (ContentBlocks)、`streamChanSize` (interface.go)
- 重连计数器 `reconnectAttempts` 在两个路径中被递增，命名不够区分

**错误处理：**
- SSE 事件 `JSON.parse` 缺少 try-catch（已在 R1 中标记为 P0）
- error 事件中二次 `JSON.parse(e.data)` 同样缺少防护
- 重连失败时降级到轮询的路径正确，但降级决策点（3次 vs 连续失败）不够清晰

### 🛡️ 健壮性 (40%) — 评分: 7.0/10

**断线重连可靠性：**

| 场景 | 处理方式 | 风险 |
|------|---------|------|
| SSE 连接断开 | 自动重连3次 → 轮询降级 | ✅ 正常路径可靠 |
| 重连后事件补齐 | `onLoadHistory()` 加载 DB 快照 | ⚠️ 重连到新 SSE 后，DB 快照之后、SSE 恢复之前的事件可能丢失 |
| 60s 无事件超时 | 关闭 EventSource → 重连 | ✅ 覆盖了服务端静默挂起场景 |
| 轮询降级 | 2s 间隔 HTTP 轮询 | ✅ 最终兜底方案 |
| 页面后台切回 | `visibilitychange` 触发重连 | ✅ 覆盖移动端场景 |

**关键风险：重连后 SSE 事件丢失无补偿**

当 SSE 断线重连时：
1. 前端调用 `onLoadHistory()` 获取 DB 快照作为基线
2. 新 SSE 连接建立，开始接收新事件
3. **问题**：在步骤1和步骤2之间，后端可能已经产生了新事件并存入 DB，但这些事件不会被新 SSE 推送（因为 SSE 只推送连接后的新事件）
4. 虽然 `onLoadHistory()` 加载了 DB 快照，但如果 DB 增量持久化有延迟（每5事件/1s ticker），快照可能不包含最新数据

**Block 合并边界：**
- 后端 `AccumulateBlock` 的 `findLastBlockOfType` 在遇到 `tool_use` 时停止搜索，这个边界设计正确
- 前端 `parseMessages` 的 tool_use ID 去重逻辑正确处理了流式更新场景
- `error` 事件被映射为 `warning` block（`accumulate.go:88`），语义有偏差但可理解（不想让 error block 打断流式渲染）

**超时处理：**
- 60s STREAM_TIMEOUT_MS 对大多数 AI 响应足够，但超长 tool_use（如长时间文件搜索）可能触发误超时
- tool_use 有独立的 30s 超时（`TOOL_USE_TIMEOUT_MS`），但只标记 done 不取消 SSE，设计合理
- 超时后 `handleStreamEnd()` 正确标记所有未完成 block 为 done

**channel 满 drop 事件：**
- `session_runtime.go:SendSessionEvent` 使用 `select + default` 非阻塞发送，channel 满时 drop event + log warning
- 前端无法感知事件被 drop — 但 DB 增量持久化已保存了这些事件
- `done` 后 `handleStreamEnd()` 会从 DB 重新加载完整消息，补偿了 drop 事件的影响

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R2-001 | **P1** | 🛡️ 健壮性 | 重连后 SSE 事件丢失无补偿：重连时 onLoadHistory 获取 DB 快照，但快照到新 SSE 之间的事件可能丢失 | `useChatStream.ts` 重连逻辑 | 重连后先 onLoadHistory，再启动新 SSE 时传入 lastEventID 让后端补发缺失事件；或重连后首次 onLoadHistory 延迟 1s 确保增量持久化完成 |
| R2-002 | **P1** | 🛡️ 健壮性 | 重连计数器双重路径叠加：onerror 和 onopen 都可能触发重连逻辑，计数器可能被双重递增 | `useChatStream.ts` 重连逻辑 | 统一重连入口，确保计数器只在一个路径递增 |
| R2-003 | **P1** | 🛡️ 健壮性 | 轮询降级后如果 SSE 恢复（如用户切换 session），轮询 interval 未清理 | `useChatStream.ts` 轮询降级 | 在 connectStream 时清理已有的轮询 interval |
| R2-004 | **P1** | 🛡️ 安全 | SSE 事件 JSON.parse 无 try-catch（已在 R1-002 标记） | `useChatStream.ts:249,265,279` | 包裹 try-catch |
| R2-005 | **P2** | 🛡️ 健壮性 | channel 满时 drop 事件前端无感知，虽然 done 后会 DB 重载，但 streaming 期间 UI 可能跳过内容 | `session_runtime.go:SendSessionEvent` | 考虑在 SSE 层增加 sequence number，前端检测 gap 后主动 onLoadHistory |
| R2-006 | **P2** | 🛡️ 健壮性 | `chat_stream.go` 心跳间隔 15s，但 STREAM_TIMEOUT_MS 为 60s，理论上 4 个心跳周期内应收到数据，但如果心跳也被 drop（channel 满），超时可能误触发 | `chat_stream.go` 心跳 + `useChatStream.ts` 超时 | 心跳应绕过 channel 直接写入 HTTP response writer，不经过 sessionStreams channel |
| R2-007 | **P2** | ✨ 质量 | SSE 事件处理器中 guard + resetTimeout + JSON.parse 模式重复约 30 行 | `useChatStream.ts` 多处 | 提取 `handleSSEEvent(type, handler)` 高阶函数 |
| R2-008 | **P2** | ✨ 质量 | 流式传输相关常量分散在 4 个文件中 | 多文件 | 提取为 `constants.ts` 集中管理 |
| R2-009 | **P2** | 🛡️ 健壮性 | `AccumulateBlock` 的 error→warning 映射语义偏差 | `accumulate.go:88` | 添加注释说明设计意图，或引入 `error` block 类型 |
| R2-010 | **P3** | ✨ 质量 | `chat_stream.go` 的 `streamEventsToSSE` 混合协议层和应用层关注点 | `chat_stream.go` 全文件 | 心跳逻辑提取为独立函数 |
| R2-011 | **P3** | 🛡️ 健壮性 | `findLastBlockOfType` 在 blocks 为空时返回 (-1, false)，调用方处理正确但缺乏显式文档 | `accumulate.go:24-35` | 添加空切片行为的注释 |

---

## 改进建议 (Top 3)

1. **重连后事件丢失补偿 (R2-001)**: SSE 断线重连后，在 onLoadHistory 和新 SSE 连接之间存在事件间隙。建议：重连成功后先 onLoadHistory()，然后短暂延迟（500ms）等待 DB 增量持久化完成，再开始处理新 SSE 事件。或者在后端实现 `Last-Event-ID` header 支持，让重连时后端从指定事件 ID 后续发。预期收益：消除重连后消息丢失风险。

2. **心跳绕过 channel 直接写入 (R2-006)**: 当前心跳通过 sessionStreams channel 传递，channel 满时心跳被 drop，导致前端 60s 超时误触发。建议：心跳应直接写入 HTTP response writer（FlushWriter），不经过 channel。预期收益：消除 channel 满导致的心跳丢失和误超时。

3. **SSE 事件处理提取高阶函数 (R2-007)**: 10+ 个事件处理器中 guard + resetTimeout + JSON.parse 模式机械重复。建议：提取 `handleSSEEvent(eventType, handler)` 高阶函数，统一处理 guard 检查、超时重置、JSON 解析和错误处理。预期收益：减少 ~30 行重复代码，集中处理 JSON.parse 错误（同时修复 R1-002）。

---

## 亮点

- **前后端 Block 合并同构**：`AccumulateBlock` 和 `parseMessages` 使用完全相同的合并规则，确保 SSE 实时构建和 DB 快照加载的状态等价
- **断连不杀 session**：SSE 断连只取消 CLI 进程，session 保留，重连后可完整恢复
- **done 后强制 DB 重载**：streaming 结束时从 DB 重新加载完整消息，补偿了 channel drop 事件的影响
- **三层容错降级**：EventSource 重连 → HTTP 轮询 → 全局会话轮询，每层独立恢复
- **visibilitychange 主动重连**：覆盖移动端切回 app 场景
- **guard 闭包隔离**：通过捕获 sessionId 快照，确保旧 session 事件不会污染新 session
