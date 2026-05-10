# R2: SSE 流式传输 Review

> 日期: 2026-05-10
> 审查范围: SSE连接 → 事件解析 → 断线重连 → 超时 → Block合并 → 渲染

## 审查范围

### 前端
- `web/src/composables/useChatStream.ts` (1-553) — SSE连接管理、事件解析、断线重连、超时处理、tool_use超时
- `web/src/composables/useChatRender.ts` (1-439) — Block解析/合并/去重、Markdown渲染、scheduled-task/ask-question解析
- `web/src/composables/useChatSession.ts` (1-539) — 连接/断开编排、session切换、全局轮询、visibility重连
- `web/src/composables/useSessionIdentity.ts` (1-227) — 模块级单例：session身份ref + action回调注册

### 后端
- `internal/handler/chat_stream.go` (1-201) — SSE HTTP handler：channel→SSE事件格式化+转发
- `internal/service/session_runtime.go` (1-174) — 运行时管理：active session追踪、stream channel、cancel函数
- `internal/ai/accumulate.go` (1-109) — 纯函数：Block累加逻辑（text/thinking合并、tool_use去重）
- `internal/ai/interface.go` (1-126) — 类型定义：StreamEvent、ToolCall、Metadata、AIBackend接口

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.0/10

**层次边界与职责分离：**
- 前端三层降级架构设计合理且清晰：SSE实时流(EventSource, 3次重连) → HTTP轮询(2s间隔) → 全局session轮询(2s间隔, useChatSession.startGlobalPolling)。每层职责明确，降级条件可追溯。
- 后端 SSE 中继层（chat_stream.go）职责极其单一：仅从 channel 读取 StreamEvent → 格式化为 SSE 协议 → 写入 HTTP response。无业务逻辑，无状态，易测试。
- `accumulate.go` 作为纯函数实现 Block 合并逻辑，零副作用，可独立单元测试，是全栈最干净的模块。
- `useSessionIdentity.ts` 将身份ref（全局共享）与操作逻辑（ChatPanel拥有）分离，通过 inversion-of-control（registerSessionActions）桥接。这个设计优雅地解决了"多组件需要session身份但操作只能在一处执行"的问题。

**前后端 Block 合并同构：**
- 后端 `AccumulateBlock` 和前端 `findLastBlockOfType` + SSE事件处理使用完全相同的合并规则：text/thinking向后查找同类型block + tool_use作为自然边界 + tool_use按ID去重。这确保了SSE实时构建和DB快照解析结果一致。
- 这是整个SSE流式架构的关键设计约束：重连后从DB加载的消息必须与之前SSE实时构建的状态等价，同构合并规则是这一保证的基础。

**断连不杀session策略：**
- SSE客户端断连后（chat_stream.go:188-197），后端仅记录日志并返回，AI goroutine继续运行直到自然完成。CLI进程不会因SSE断连被杀。
- 前端重连时通过`onLoadHistory()`从DB获取完整快照，再通过SSE继续接收新事件。这意味着断连窗口中的AI输出不会丢失（已持久化到DB）。

**可扩展性：**
- AIBackend接口（interface.go:119-125）设计简洁：`Name()` + `ExecuteStream()` 两个方法。新后端只需实现这两个方法。
- SSE事件类型通过字符串区分（interface.go:72），后端switch-case扩展新类型简单直接。

**关注点：**
- `useChatStream` 同时承担SSE连接管理 + 事件解析 + 消息状态修改 + 超时管理 + 轮询降级，534行，职责略重。可考虑将轮询降级提取为独立composable。
- `useChatRender` 中的`renderTextBlock`函数承担了过多职责（scheduled-task提取 + ask-question解析 + markdown渲染），嵌套层级深，可读性受影响。
- `chat_stream.go` 的for-select循环既做事件转发又做session存活检查，混合了协议层和应用层关注点。但鉴于该文件只有201行，当前可接受。

### ✨ 代码质量 (30%) — 评分: 7.5/10

**设计亮点：**
- `connectStream` 的guard闭包设计（行219-223）：通过捕获`sessionId`快照，确保只有当前session的事件被处理。这比在每次事件中检查`currentSessionId.value`更可靠，因为闭包捕获的是不变量。
- `findLastBlockOfType`（行235-242）与`AccumulateBlock`中的同名闭包使用完全一致的算法，包括tool_use边界语义。前后端同构的设计意图在代码层面有清晰体现。
- `queue_consume`事件中更新`lastIndex`闭包变量（行443），确保后续事件处理器能正确定位到新的assistant消息。注释"CRITICAL: update closure variable"表明开发者理解了这个关键点。
- `forceCleanupStreamingState`（行109-125）统一处理所有中断路径的streaming状态清理，避免重复代码。
- `switchSessionSeq`序列号（useChatSession.ts:108）防止并发switch导致的状态覆盖，是比async-lock更轻量的方案。
- `buildMessageSnapshot`（useChatSession.ts:132-138）用轻量级指纹检测消息变化，避免轮询时无变化数据的UI刷新。设计考虑周全。
- `ContentBlock`的`Input`字段不用`omitempty`（model/chat.go:50），确保`done=false`能通过DB round-trip。注释说明了设计意图。
- `ToolCall.Input`作为JSON string存储（interface.go:91），在AccumulateBlock/chat_stream.go中延迟解析为map。这种设计避免了StreamEvent携带parsed map的序列化开销。

**代码重复：**
- SSE事件处理中`JSON.parse(e.data)` + guard检查 + `resetStreamTimeout()`模式在每个事件处理器中重复，约10个事件类型。可提取为通用helper：`function withGuard(e, handler) { if (!guard()) return; resetStreamTimeout(); try { handler(JSON.parse(e.data)) } catch { console.error(...) } }`。
- `forceCleanupStreamingState`的逻辑（标记unfinished tool_use为done + 删除streaming + 重置loading）在`cancelled`事件、`queue_done`事件中也有局部重复。
- `done`事件和`pollUntilDone`中的通知逻辑（onToast + onNotification）完全重复（useChatStream.ts:364-373 vs 173-182）。

**错误处理：**
- SSE事件`JSON.parse`缺少try-catch — 8处无防护调用（行247, 263, 277, 334, 349, 422, 454, 491）。这是最严重的代码质量问题。畸形JSON会抛异常杀死整个事件监听器。
- error事件的catch回调中`JSON.parse(e.data)`（行491）同样缺少防护，且此处`e`是SSE `addEventListener('error')`事件，其`e.data`是后端SSE event data字符串，解析失败会导致fallback错误处理本身崩溃。
- `AccumulateBlock`中`json.Unmarshal`忽略错误（accumulate.go:57），空input默认为空map。这是有意的宽容设计，但应在注释中说明。
- `chat_stream.go`中`json.Marshal`忽略错误（行78, 81, 104, 119, 123, 131, 142, 154, 158, 168），虽然json.Marshal对map几乎不可能失败，但缺少注释说明这一假设。

**命名与注释：**
- 关键设计决策都有注释说明：tool_use边界语义（useChatStream.ts:233-234）、done后DB重载原因（行357-358）、guard闭包设计意图（行218）、queue_consume中lastIndex更新（行443）。
- `FILE_MODIFYING_TOOLS`常量（行26）注释说明了PascalCase规范化保证。
- `SendSessionEvent`返回bool但调用方多不检查，语义不清。
- `ForceCancelSession`有完整注释（session_runtime.go:116-118），但实际未被任何生产代码调用（dead code），容易误导。

### 🛡️ 健壮性 (40%) — 评分: 7.0/10

**SSE事件解析脆弱性（最严重问题）：**
- `useChatStream.ts`中8处`JSON.parse`无try-catch防护。任何一处解析异常都会杀死EventSource的addEventListener回调，导致该事件类型的所有后续事件被静默丢弃。EventSource本身不会因此断开，但特定事件监听器会被GC（因为异常跳出后引擎移除了当前调用的引用）。实际表现为"AI仍在运行但UI不再更新"——用户只能手动刷新。
- 这不是理论风险：AI tool的output字段可能包含用户代码中的特殊字符，`json.Marshal`在Go中总是产生合法JSON，但SSE传输层（反向代理、CDN）可能截断或修改数据。

**error事件处理器中的逻辑缺陷：**
- 行498-499：error事件catch回调在设置`messages.value[lastIndex].blocks = [errorBlock]`后，遍历`messages.value[lastIndex].blocks`寻找unfinished tool_use。但此时blocks已被替换为只含一个error block的数组，遍历毫无意义。原意可能是先遍历旧blocks标记done，再替换，但代码顺序相反。
- 行491：`JSON.parse(e.data)`如果失败，整个catch回调抛异常，loading.value永远不会被设为false，UI永远卡在loading状态。

**channel关闭与终态事件语义：**
- `chat_stream.go:67-73`：channel close时始终emit `done`事件。但channel可能因ForceCancel（或future use of ForceCancelSession）而close，此时应emit `cancelled`。当前代码无法区分close原因。
- 然而，由于`ForceCancelSession`目前是dead code（未被任何生产代码调用），这个问题在当前版本中不会触发。`CancelSession`在channel close之前通过非阻塞发送`cancelled`事件（session_runtime.go:100-108），所以正常取消路径的`cancelled`事件能正确投递。
- 实际风险场景：如果未来有人调用`ForceCancelSession`，channel close后的`done`事件会覆盖`cancelled`语义。

**重连后事件间隙：**
- 前端重连流程：`disconnectStream()` → `connectStream(sessionId)`。新SSE连接从当前channel位置开始读取。但在`disconnectStream`和`connectStream`之间，如果AI发出了事件，这些事件在channel buffer中，新SSE handler会读取到它们——这实际上是安全的，因为事件不会丢失。
- 但`onerror`路径的重连有个微妙问题（行507-520）：`disconnectStream()`关闭旧EventSource，然后立即调用`connectStream()`。`connectStream`内部也先调用`disconnectStream()`（行196），这是幂等的。然后创建新EventSource。此时如果后端session已经结束（AI在断连窗口中完成），新SSE连接会收到`error`事件（session not running），前端会降级到`pollUntilDone`。这条路径是正确的。
- 超时重连路径（行70-86）有个问题：`disconnectStream()`后检查`reconnectAttempts < MAX_RECONNECT_ATTEMPTS`，然后调用`connectStream()`。但`connectStream`内部（行198）会重置`reconnectAttempts = 0`，导致重试计数器永远不会超过1。这意味着MAX_RECONNECT_ATTEMPTS=3实际上等于1，超时重连只尝试1次就降级到轮询。

**`reconnectAttempts`计数器失效：**
- 如上分析，`connectStream`（行198）无条件重置`reconnectAttempts = 0`，而超时重连和onerror重连都在调用`connectStream`前递增计数器。这导致每次重连计数器从0重新开始，MAX_RECONNECT_ATTEMPTS限制完全失效。
- 实际影响：超时重连永远只尝试1次（递增到1 → connectStream重置为0 → 下次超时又从1开始）。onerror重连同理。

**tool_use超时与done事件竞态：**
- 前端tool_use有30s超时（行59, 318-325），超时后将block标记为done。但如果done事件在超时后到达，`existing.done = true`赋值是幂等的，不会造成功能问题。超时处理器的`toolUseTimeouts.delete(data.id)`（行324）与done事件中的`toolUseTimeouts.get(data.id)`（行292-293）之间没有竞态，因为JavaScript是单线程的。

**`ForceCancelSession`是dead code：**
- `ForceCancelSession`（session_runtime.go:119-129）定义了完整逻辑（存储cancel reason、清空队列、取消context），但**没有任何生产代码调用它**。这意味着：
  1. SSE断连后AI goroutine不会被强制取消，会一直运行到自然完成。对于长时间运行的AI任务，这可能导致资源浪费。
  2. CODEBUDDY.md中描述的"ForceCancelSession kills zombie CLI processes on SSE disconnect"实际上未实现。
  3. 函数签名暗示它会设置running=false（通过cancel后的defer），但不直接调用`SetSessionRunning(false)`——如果goroutine panic被recover，cancel后的defer可能不执行。

**checkTicker竞态（低风险）：**
- `chat_stream.go:179-186`：checkTicker每2s检查`IsSessionRunning`，如果session不再running则发送cancelled。但AI goroutine正常完成时，defer顺序是：`SetSessionRunning(false)` → `UnregisterSessionStream()` → close(channel)。checkTicker可能在`SetSessionRunning(false)`之后、channel close之前触发，此时会发送`cancelled`而不是让channel close触发`done`。
- 实际影响低：因为checkTicker间隔是2s，而defer之间是顺序执行的微秒级操作，窗口极小。但在高负载或GC pause时理论上可能触发。

**`SendSessionEvent`事件丢失：**
- `SendSessionEvent`（session_runtime.go:162-173）使用`select + default`非阻塞发送，channel满时drop event。channel buffer为64（行133），在正常使用中不太可能满。但如果AI在极短时间内产生大量事件（如大文件Read输出），理论上可能溢出。
- `CancelSession`中的`cancelled`事件也使用非阻塞发送（行100-108），如果channel满了，前端收不到cancelled事件。此时checkTicker会在2s内检测到session不再running并发送cancelled，作为兜底。

**error事件中`e.data`类型安全：**
- `addEventListener('error')`的事件`e`是`MessageEvent`类型，`e.data`应为string。但如果后端SSE格式错误导致浏览器无法解析event data，`e.data`可能是null或undefined。行491的`JSON.parse(e.data)`会抛`SyntaxError`，而此处已在catch回调中，异常会静默吞掉，导致loading状态不重置。

**AccumulateBlock的tool_use input覆盖：**
- `accumulate.go:66`：找到已有tool_use block后，无条件用`input`覆盖`(*blocks)[i].Input`。如果done事件的input为空（解析后为`map[string]any{}`），会覆盖之前start事件收到的完整input。前端（useChatStream.ts:309-310）仅在`Object.keys(data.input).length > 0`时覆盖，逻辑更安全。
- 实际影响：DB中存储的tool_use block的input可能被空map覆盖，导致重连后从DB加载时tool input丢失。但当前后端stream parser似乎总是提供完整input（start和done事件都包含），所以空input的done事件可能不会实际出现。

**`warning`事件引用`streamingText`：**
- useChatStream.ts:407-409：warning事件处理中检查`msg.streamingText`并push到blocks。但`streamingText`不是SSE事件流中使用的字段——SSE流直接操作`msg.blocks`，不经过`streamingText`中间变量。这可能是旧代码残留，`msg.streamingText`永远为falsy，所以这个if-block是死代码。不影响功能，但增加认知负担。

**pollUntilDone的竞态安全：**
- pollUntilDone（行131-193）中，`data.running`为false时停止轮询并解析消息。但`currentSessionId.value`可能在fetch开始和结果处理之间被修改（如用户快速切换session）。行167的`currentSessionId.value = data.sessionId || currentSessionId.value`可能在旧session的polling结果中覆盖新session的ID。
- 但因为pollUntilDone在disconnect后启动，而switchSession会调用`onStopPolling()`（useChatSession.ts:244），所以正常流程中不会发生。但如果stopPolling和polling interval回调之间存在时序交错（setInterval回调在stopPolling之前已在event loop中排队），理论上可能。

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R2-001 | **P0** | 🛡️ 健壮性 | JSON.parse无try-catch：8处SSE事件解析无防护，畸形数据杀死事件监听器，UI永久卡住 | `useChatStream.ts:247,263,277,334,349,422,454` | 包裹try-catch，失败时console.error并跳过当前事件 |
| R2-002 | **P0** | 🛡️ 健壮性 | `reconnectAttempts`在`connectStream`中被重置为0（行198），导致MAX_RECONNECT_ATTEMPTS=3实际等于1，超时/onerror重连只尝试1次就降级 | `useChatStream.ts:198,77-78,511-513` | 将`reconnectAttempts = 0`移到`connectStream`外部，仅在首次连接时重置 |
| R2-003 | **P0** | 🛡️ 健壮性 | error事件catch回调中`JSON.parse(e.data)`无防护（行491），失败时loading永远不重置；且blocks被替换后再遍历寻找tool_use（行498-499）是无效操作 | `useChatStream.ts:491,496-499` | 包裹try-catch；先遍历旧blocks标记done再替换 |
| R2-004 | **P1** | 🛡️ 健壮性 | `ForceCancelSession`是dead code，CODEBUDDY.md描述的"SSE断连后杀zombie进程"未实际实现。长时间AI任务在SSE断连后继续占用资源 | `session_runtime.go:119-129` | 在chat_stream.go的`r.Context().Done()`路径中调用ForceCancelSession，或删除dead code并更新文档 |
| R2-005 | **P1** | 🛡️ 健壮性 | Channel close始终emit `done`（chat_stream.go:69），无法区分正常完成和ForceCancel。若未来启用ForceCancelSession，用户取消会显示为正常完成 | `chat_stream.go:67-73` | 在close channel前发送显式终态事件，或在session runtime中记录close reason |
| R2-006 | **P1** | 🛡️ 健壮性 | `AccumulateBlock`在找到已有tool_use block后无条件覆盖Input（accumulate.go:66），空input的done事件会清除之前start事件的完整input | `accumulate.go:66` | 仅在`len(input) > 0`时覆盖，与前端逻辑（useChatStream.ts:309-310）保持一致 |
| R2-007 | **P1** | 🛡️ 健壮性 | 无服务端SSE心跳，长空闲期间（AI思考中）前端60s超时触发不必要重连，浪费资源 | `chat_stream.go`全文件 | 添加15-30s SSE heartbeat comment（`: heartbeat\n\n`），前端resetStreamTimeout时忽略comment事件 |
| R2-008 | **P1** | 🛡️ 竞态 | checkTicker在`SetSessionRunning(false)`与channel close之间的窗口期可能发送错误的`cancelled`事件（极小概率） | `chat_stream.go:179-186` | 在channel close后设置一个标志，checkTicker检查该标志跳过cancelled |
| R2-009 | **P1** | 🛡️ 健壮性 | `CancelSession`的`cancelled`事件非阻塞发送可能被drop（channel满），前端不知道session已被取消，依赖2s后checkTicker兜底 | `session_runtime.go:100-108` | 对cancelled事件使用带超时的阻塞发送（如1s timeout），或增大channel buffer |
| R2-010 | **P2** | ✨ 质量 | warning事件引用不存在的`streamingText`字段（行407-409），是死代码，增加认知负担 | `useChatStream.ts:407-409` | 删除dead code，或确认是否有其他代码设置此字段 |
| R2-011 | **P2** | ✨ 质量 | SSE事件处理中JSON.parse+guard+resetStreamTimeout模式重复10次，约30行机械重复 | `useChatStream.ts` | 提取通用helper：`function handleEvent(e, handler) { if (!guard()) return; resetStreamTimeout(); try { handler(JSON.parse(e.data)) } catch { console.error(...) } }` |
| R2-012 | **P2** | ✨ 质量 | done事件和pollUntilDone中的通知逻辑（onToast + onNotification）完全重复 | `useChatStream.ts:364-373 vs 173-182` | 提取为`notifyAIReplied()`函数 |
| R2-013 | **P2** | 🛡️ 健壮性 | `SendSessionEvent`返回bool但所有调用方都不检查返回值，事件被静默drop | `session_runtime.go:162-173` | 要么让调用方检查返回值，要么终态事件使用阻塞发送 |
| R2-014 | **P2** | ✨ 质量 | `StreamEvent.Type`为无类型string，switch-case无exhaustive检查，新增事件类型容易遗漏处理 | `interface.go:72` | 定义`EventType`常量类型（如`type EventType = string`），或在go侧使用iota + string |
| R2-015 | **P2** | ✨ 质量 | error类型存储为warning ContentBlock（accumulate.go:106），语义偏差 | `accumulate.go:106` | 添加注释说明设计意图（"error blocks stored as warning for unified UI rendering"），或引入error block type |
| R2-016 | **P2** | ✨ 质量 | Content-Type缺少charset=utf-8（chat_stream.go:34），某些代理可能错误编码SSE数据 | `chat_stream.go:34` | 改为`text/event-stream; charset=utf-8` |
| R2-017 | **P2** | ✨ 质量 | error事件序列化使用`%q`而非json.Marshal（chat_stream.go:41），与其他事件格式不一致 | `chat_stream.go:41` | 使用json.Marshal保持一致性 |
| R2-018 | **P2** | ✨ 质量 | `parseAssistantContent`中catch异常完全静默（useChatRender.ts:260），DB中损坏的content无法被发现 | `useChatRender.ts:260` | 至少`console.warn('Failed to parse assistant content:', e)` |
| R2-019 | **P3** | ✨ 质量 | `TOOL_USE_TIMEOUT_MS`/`STREAM_TIMEOUT_MS`/`MAX_RECONNECT_ATTEMPTS`硬编码在composable内部，无法配置 | `useChatStream.ts:57-59` | 提取为options参数或集中配置 |
| R2-020 | **P3** | 🛡️ 健壮性 | `pollUntilDone`中`currentSessionId.value`可能在fetch异步期间被修改（用户切换session），导致写入错误的sessionId | `useChatStream.ts:167` | 在fetch前捕获sessionId快照，结果处理时校验 |
| R2-021 | **P3** | ✨ 质量 | `useChatRender`中`renderTextBlock`嵌套过深（scheduled-task + ask-question + markdown），可读性差 | `useChatRender.ts:114-202` | 提取`scheduled-task`和`ask-question`解析为独立函数 |

---

## 改进建议 (Top 3)

1. **修复JSON.parse try-catch + reconnectAttempts计数器失效 (R2-001 + R2-002)**: 这两个P0问题是SSE流式传输最严重的健壮性缺陷。`JSON.parse`无防护可导致整个SSE stream事件监听器崩溃，8处调用全部暴露，用户看到的是"AI卡住"。`reconnectAttempts`在`connectStream`中被重置，导致MAX_RECONNECT_ATTEMPTS=3实际等于1，超时和连接错误只重试1次就降级到轮询。建议：(1) 提取通用`handleEvent`helper包裹try-catch，所有事件处理器使用此helper；(2) 将`reconnectAttempts = 0`移到`connectStream`外部，仅在用户主动发起新chat时重置，重连路径不重置。预期收益：消除SSE stream崩溃风险，恢复3次重连的容错能力。

2. **添加服务端SSE心跳 + 启用ForceCancelSession (R2-007 + R2-004)**: 当前无服务端心跳，AI思考期间前端60s超时触发不必要重连，浪费资源且可能导致事件间隙。ForceCancelSession是dead code，SSE断连后AI goroutine一直运行到自然完成，长时间任务可能成为zombie进程。建议：(1) 在chat_stream.go的for-select循环中添加heartbeat ticker，每15-30s发送`: heartbeat\n\n` SSE comment（绕过sessionStreams channel，直接写入response writer）；(2) 在`r.Context().Done()`路径中调用`ForceCancelSession`，使SSE断连后AI进程被回收。预期收益：消除长空闲误超时和资源浪费，确保SSE断连后系统资源被及时释放。

3. **修复AccumulateBlock tool_use input覆盖 + error事件处理器逻辑 (R2-006 + R2-003)**: 后端`AccumulateBlock`在找到已有tool_use block后无条件覆盖Input，空input的done事件会清除之前start事件的完整input，导致DB存储与前端SSE实时构建状态不一致。error事件catch回调中JSON.parse无防护且blocks替换后再遍历是无效操作。建议：(1) `AccumulateBlock`仅在`len(input) > 0`时覆盖已有block的Input，与前端逻辑保持一致；(2) error事件catch回调中先遍历旧blocks标记tool_use done，再替换为error block，JSON.parse包裹try-catch。预期收益：消除前后端Block合并的语义分歧，确保重连后DB快照与SSE实时构建状态等价；修复error fallback中的死代码和潜在异常。

---

## 亮点

- **前后端Block合并同构**：`AccumulateBlock`和`findLastBlockOfType`使用完全相同的合并规则（text/thinking向后查找 + tool_use边界 + ID去重），确保SSE实时构建和DB快照加载的状态等价。这是整个SSE架构正确性的基石。
- **断连不杀session策略**：SSE断连后AI goroutine继续运行，输出持久化到DB，前端重连后通过`onLoadHistory()`完整恢复。这是比"断连即取消"更用户友好的设计。
- **done后强制DB重载**：streaming结束时从DB重新加载完整消息（useChatStream.ts:359），补偿了channel事件丢失的影响。这是深度防御（defense-in-depth）思维。
- **三层容错降级**：SSE重连(3次) → HTTP轮询(2s) → 全局session轮询(2s)，每层独立恢复，确保极端网络条件下AI结果不丢失。
- **visibilitychange主动重连**：移动端切回app时主动重连（useChatSession.ts:494-503），覆盖了最常见的中断场景。
- **guard闭包隔离**：通过捕获sessionId快照，确保旧session事件不会污染新session。比每次检查`currentSessionId.value`更可靠。
- **switchSessionSeq防并发**：轻量级序列号方案，比async-lock更简单，有效防止并发session切换的状态覆盖。
- **AccumulateBlock纯函数设计**：零副作用，可独立测试，是全栈最干净的模块。
- **tool_use超时兜底**：前端30s tool_use超时（useChatStream.ts:318-325）作为安全网，防止spinner无限旋转。
- **tool_result事件支持**：后端和前端都处理独立的`tool_result`事件（chat_stream.go:107-120, useChatStream.ts:332-344），支持Gemini等将tool结果作为独立事件发送的后端。
