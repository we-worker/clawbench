# R6: TTS 语音流程 Review

> 日期: 2026-05-24
> 审查范围: 文本 → 摘要压缩 → TTS引擎 → 音频响应 → 前端播放

## 审查范围

### 前端
- `web/src/composables/useAutoSpeech.ts` (1-326) — 自动语音控制
- `web/src/components/media/AudioPreview.vue` (1-117) — 音频预览
- `web/src/components/chat/ChatMessageItem.vue` (TTS按钮部分)

### 后端
- `internal/handler/tts.go` (1-306) — TTS API
- `internal/speech/interface.go` (1-130) — 接口定义 + StripMarkdown
- `internal/speech/summarizer.go` (1-223) — 摘要器选择
- `internal/speech/simple_summarizer.go` (1-30) — 简单摘要
- `internal/speech/mmx_summarizer.go` (1-68) — MiniMax摘要
- `internal/speech/ai_backend_summarizer.go` (1-83) — AI后端摘要
- `internal/speech/ollama_summarizer.go` (1-132) — Ollama摘要
- `internal/speech/minimax.go` (1-92) — MiniMax TTS引擎
- `internal/speech/edge_tts.go` (1-96) — Edge TTS引擎
- `internal/speech/piper.go` (1-160) — Piper本地引擎
- `internal/speech/kokoro.go` (1-141) — Kokoro ONNX引擎
- `internal/speech/moss_tts_nano.go` (1-158) — Moss Nano引擎

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 8.0/10

**接口设计优秀：**
- `SpeechProvider` 接口精简（`Synthesize` 一个方法），5 个引擎实现一致
- `Summarizer` 接口同样精简（`Summarize` 一个方法），4 种摘要策略（Simple/MiniMax/AIBackend/Ollama）可组合
- `StripMarkdown` 的 5 阶段清洗（转义→块级→行级→URL→残留）设计合理，正则预编译避免性能问题

**TTS Job 异步架构：**
- 请求 → 检查缓存 → 缓存命中直接返回 / 缓存未命中启动异步 Job → SSE 流式推送进度
- 两阶段流水线：summarize（60s 超时）→ synthesize（120s 超时）
- 前端通过 EventSource 接收 phase/result 事件

**关注点：**
- `speechProvider` 和 `summarizer` 是全局变量（`tts.go:32,41`），不支持运行时切换
- TTS Job 管理通过 `service` 包的全局 `sync.Map` 实现，与 Session Runtime 的设计模式一致
- `StripMarkdown` 对残留 markdown 的清理可能过于激进（`stripResidualMarkdown` 移除所有 `*#~` 等字符），数学公式会被破坏

### ✨ 代码质量 (30%) — 评分: 7.5/10

**亮点：**
- `StripMarkdown` 的 `InlineCodeMaxLen` 可配置（config.yaml），短代码保留文本（变量名），长代码移除
- 缓存机制完善：SHA-256 哈希 → DB 摘要缓存 + 文件缓存双层
- 各 TTS 引擎的实现风格一致：构造 HTTP 请求 → 读取响应 → 写入文件

**关注点：**
- `tts.go:97-105` 引擎类型判断使用 type assertion 获取文件扩展名，应改为在 `SpeechProvider` 接口添加 `FileExtension()` 方法
- `summarizer.go` 的 `selectSummarizer` 使用 `reflect.TypeOf` 判断引擎类型，耦合了具体实现
- 多个 TTS 引擎的 HTTP 客户端未设置超时（依赖 context 传递），如果 context 取消但 HTTP 请求已发出，响应可能泄漏

### 🛡️ 健壮性 (40%) — 评分: 7.0/10

**P0 级问题：**

1. **`SendTTSEvent` 非阻塞写入**：当 `StreamCh` 缓冲区满时，`result` 事件会被静默丢弃，前端永远收不到结果，SSE 连接会超时断开

2. **`CloseTTSJobDone` 并发 `close` panic**：`CancelTTSJob` 和 `CloseTTSJobDone` 并发执行时可能重复关闭 `Done` channel

**P1 级问题：**

3. **摘要无降级**：LLM 后端超时后直接返回 `SummarizeFailed`，用户只能看到"摘要失败"，而不能听到原文 TTS。应 fallback 到 SimpleSummarizer（截断）

4. **EventSource 连接竞态**：`useAutoSpeech` 中 `es.onerror` 和 `result` 事件可能同时触发 `handleResult`（与 R1-006 同源）

5. **TTS Job 内存泄漏**：如果前端在 Job 完成前断开 SSE，`CancelTTSJob` 会 cancel context，但如果 goroutine 已经在 synthesize 阶段（`speechProvider.Synthesize`），cancel 可能不被及时响应，goroutine 挂起直到超时

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R6-001 | **P0** | 🛡️ 健壮性 | `SendTTSEvent` 非阻塞写入，channel 满时 result 事件被 drop | `service/` TTS Job 管理 | result 事件应使用阻塞发送或重试 |
| R6-002 | **P0** | 🛡️ 竞态 | `CloseTTSJobDone` 和 `CancelTTSJob` 并发关闭 Done channel | `service/` TTS Job 管理 | 使用 sync.Once 保护 close |
| R6-003 | **P1** | 🛡️ 健壮性 | 摘要失败无降级，用户无法听到任何语音 | `tts.go:159-169` | 摘要失败时 fallback 到 SimpleSummarizer 或直接用原文 |
| R6-004 | **P1** | 🛡️ 竞态 | EventSource onerror 和 result 事件双重调用 handleResult | `useAutoSpeech.ts:189-215` | 添加 resultHandled 标志位（与 R1-006 同源） |
| R6-005 | **P1** | 🛡️ 泄漏 | SSE 断连后 synthesize 阶段可能不响应 cancel | `tts.go:188-190` | 确保所有 Synthesize 实现正确响应 context cancel |
| R6-006 | **P2** | 🏗️ 架构 | speechProvider/summarizer 全局变量不支持运行时切换 | `tts.go:32,41` | 引入 TTSProvider struct 持有状态 |
| R6-007 | **P2** | ✨ 质量 | 引擎类型判断使用 type assertion 获取扩展名 | `tts.go:97-105` | 在 SpeechProvider 接口添加 FileExtension() |
| R6-008 | **P2** | ✨ 质量 | selectSummarizer 使用 reflect.TypeOf | `summarizer.go` | 改用接口方法或配置驱动 |
| R6-009 | **P2** | 🛡️ 健壮性 | StripMarkdown 的 stripResidualMarkdown 可能破坏数学公式 | `interface.go:110-113` | KaTeX 块应先提取再清洗 |
| R6-010 | **P2** | 🛡️ 健壮性 | TTS 缓存文件无过期机制，磁盘可能持续膨胀 | `tts.go:106` | 定期清理 .clawbench/generated/tts/ 下的旧文件 |
| R6-011 | **P2** | ✨ 质量 | 多个 TTS 引擎 HTTP 客户端未设置超时 | `minimax.go, edge_tts.go` 等 | 依赖 context 传递超时，但 HTTP client 本身应有兜底 |
| R6-012 | **P3** | ✨ 质量 | useAutoSpeech 播放列表无大小限制 | `useAutoSpeech.ts` | 添加最大队列长度 |
| R6-013 | **P3** | ✨ 质量 | AudioPreview 组件未处理 audio 元素错误事件 | `AudioPreview.vue` | 添加 onerror 处理 |

---

## 改进建议 (Top 3)

1. **修复 TTS Job 事件投递和并发安全 (R6-001+R6-002)**: `SendTTSEvent` 的 result 事件应使用阻塞发送（`ch <- event`）或重试机制，确保前端始终收到结果。`CloseTTSJobDone` 和 `CancelTTSJob` 的并发 close 使用 `sync.Once` 保护。预期收益：消除前端 TTS 永远等待和 goroutine panic 的风险。

2. **摘要失败降级策略 (R6-003)**: 当 LLM 摘要超时或失败时，应自动 fallback 到 SimpleSummarizer（截断到最大字符数），而非直接返回失败。用户应始终能听到语音，即使质量较低。预期收益：提升用户体验，避免"摘要失败"的死胡同。

3. **SpeechProvider 接口扩展 (R6-007+R6-008)**: 在 `SpeechProvider` 接口添加 `FileExtension() string` 方法，避免 handler 层通过 type assertion 获取扩展名。`selectSummarizer` 改为配置驱动而非反射驱动。预期收益：消除 handler 与具体 TTS 引擎实现的耦合。

---

## 亮点

- **StripMarkdown 5 阶段清洗**：转义→块级→行级→URL→残留，正则预编译，`InlineCodeMaxLen` 可配置
- **双层缓存**：SHA-256 哈希 → DB 摘要缓存 + 文件缓存，缓存命中时直接返回无需计算
- **两阶段流水线 + SSE**：summarize → synthesize 的异步流水线，前端通过 SSE 实时获取进度
- **5 个 TTS 引擎一致实现**：MiniMax(云端)、Edge TTS(云端免费)、Piper(本地)、Kokoro(ONNX)、Moss Nano，切换仅需配置
- **请求体大小限制**：`ttsMaxBodyBytes = 1MB` 防止超大文本攻击
