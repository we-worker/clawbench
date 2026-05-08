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

### 🏗️ 架构设计 (30%) — 评分: 7.8/10

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

### ✨ 代码质量 (30%) — 评分: 7.3/10

**亮点：**
- `StripMarkdown` 的 `InlineCodeMaxLen` 可配置（config.yaml），短代码保留文本（变量名），长代码移除
- 缓存机制完善：SHA-256 哈希 → DB 摘要缓存 + 文件缓存双层
- 各 TTS 引擎的实现风格一致：构造 HTTP 请求 → 读取响应 → 写入文件

**关注点：**
- `tts.go:97-105` 引擎类型判断使用 type assertion 获取文件扩展名，应改为在 `SpeechProvider` 接口添加 `FileExtension()` 方法
- `summarizer.go` 的 `selectSummarizer` 使用 `reflect.TypeOf` 判断引擎类型，耦合了具体实现
- 多个 TTS 引擎的 HTTP 客户端未设置超时（依赖 context 传递），如果 context 取消但 HTTP 请求已发出，响应可能泄漏

### 🛡️ 健壮性 (40%) — 评分: 6.5/10

**P0 级问题：**

1. **EventSource result+onerror 双重调用**：`useAutoSpeech.ts:189-215` 中 `handleResult` 可被 result 事件和 onerror 同时触发，创建孤立的 audio 元素

2. **摘要失败 = 无音频**：`tts.go:159-168` 摘要失败时发送 `SynthesizeFailed` 而非降级到 SimpleSummarizer，用户无法听到任何语音

3. **Job ID 碰撞**：`tts_runtime.go:80-94` 同一 cacheKey 用作 job ID；取消的 job 的 goroutine 可能删除新 job 的 StreamCh

**P1 级问题：**

4. **`SendTTSEvent` channel 满时静默丢弃 result 事件**：前端永远收不到结果，SSE 连接超时断开

5. **`genericSummarizer.Summarize` 无 pass-1 失败降级**：`summarizer.go:94-123`

6. **Cancel 不杀进程组**：`exec.CommandContext` 仅杀父进程 — `minim.go:69`, `mmx_summarizer.go:47`

7. **Language 参数被静默忽略**：Edge TTS、Piper、Kokoro、MOSS 均不支持 — `edge_tts.go:40`, `piper.go:40`, `kokoro.go:54`, `moss_tts_nano.go:63`

8. **AIBackendSummarizer 过重**：启动完整 CLI 进程 — `ai_backend_summarizer.go:53`

9. **SSE 断连立即终止合成**：`tts.go:288-294` 无宽限期

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R6-001 | **P0** | 🛡️ 健壮性 | EventSource result+onerror 双重调用 handleResult，创建孤立 audio 元素 | `useAutoSpeech.ts:189-215` | 添加 resultHandled 标志位 |
| R6-002 | **P0** | 🛡️ 健壮性 | 摘要失败直接返回 SynthesizeFailed，无降级 | `tts.go:159-168` | fallback 到 SimpleSummarizer 或直接用原文 |
| R6-003 | **P0** | 🛡️ 竞态 | Job ID 碰撞：同一 cacheKey 用作 job ID，取消的 goroutine 可能删除新 job 的 StreamCh | `tts_runtime.go:80-94` | 使用唯一 job ID，与 cacheKey 分离 |
| R6-004 | **P1** | 🛡️ 健壮性 | SendTTSEvent channel 满时 result 事件被静默丢弃 | `tts_runtime.go:62-77` | result 事件使用阻塞发送或重试 |
| R6-005 | **P1** | 🛡️ 健壮性 | genericSummarizer.Summarize 无 pass-1 失败降级 | `summarizer.go:94-123` | pass-1 失败时 fallback 到 SimpleSummarizer |
| R6-006 | **P1** | 🛡️ 泄漏 | exec.CommandContext 仅杀父进程，子进程可能存活 | `minim.go:69`, `mmx_summarizer.go:47` | 使用进程组 kill |
| R6-007 | **P1** | ✨ 质量 | Language 参数被 Edge TTS/Piper/Kokoro/MOSS 静默忽略 | `edge_tts.go:40` 等 | 返回 warning 或在文档中明确 |
| R6-008 | **P1** | 🏗️ 架构 | AIBackendSummarizer 启动完整 CLI 进程，资源消耗大 | `ai_backend_summarizer.go:53` | 考虑轻量 HTTP 摘要接口 |
| R6-009 | **P1** | 🛡️ 健壮性 | SSE 断连立即终止合成，无宽限期 | `tts.go:288-294` | 添加短宽限期让合成完成 |
| R6-010 | **P2** | 🛡️ 健壮性 | StripMarkdown 不处理 KaTeX/LaTeX 数学公式 | `interface.go:60-104` | 先提取 KaTeX 块再清洗 |
| R6-011 | **P2** | ✨ 质量 | stripResidualMarkdown 过于激进，移除 "C#" 的 # 和 "5*3=15" 的 * | `interface.go:110` | 添加上下文感知规则 |
| R6-012 | **P2** | 🛡️ 泄漏 | tts_summaries 表无清理/TTL 机制 | `database.go:130-134` | 定期清理过期摘要记录 |
| R6-013 | **P2** | 🛡️ 健壮性 | 缓存 key 仅基于文本，不含 language | `tts.go:92` | cacheKey 应包含 language |
| R6-014 | **P2** | 🛡️ 泄漏 | Audio 元素 stop 时未完全释放 | `useAutoSpeech.ts:92` | 显式释放 src 和 audio 对象 |
| R6-015 | **P2** | ✨ 质量 | Done channel 为死代码 | `tts_runtime.go:79-94` | 移除或重构 |
| R6-016 | **P2** | 🛡️ 健壮性 | 死亡 .summary.txt 文件 fallback | `tts.go:115-131` | 移除遗留兼容代码 |

---

## 改进建议 (Top 3)

1. **修复 EventSource 双重调用 (R6-001)**: 在 `useAutoSpeech.ts` 的 `handleResult` 入口添加 `resultHandled` 标志位，确保 result 事件和 onerror 只触发一次处理逻辑。这是前端最直接的用户体验问题——孤立的 audio 元素导致重复播放或内存泄漏。

2. **摘要失败降级策略 (R6-002+R6-005)**: 当 LLM 摘要超时或失败时，应自动 fallback 到 SimpleSummarizer（截断到最大字符数），而非直接返回失败。`genericSummarizer.Summarize` 的 pass-1 失败也应降级。用户应始终能听到语音，即使质量较低。

3. **修复 Job ID 碰撞 (R6-003)**: 使用唯一 job ID（如 UUID）与 cacheKey 分离。取消 job 时只清理对应 job ID 的资源，不影响新 job 的 StreamCh。预期收益：消除缓存命中场景下的竞态条件。

---

## 亮点

- **StripMarkdown 5 阶段清洗**：转义→块级→行级→URL→残留，正则预编译，`InlineCodeMaxLen` 可配置
- **双层缓存**：SHA-256 哈希 → DB 摘要缓存 + 文件缓存，缓存命中时直接返回无需计算
- **5 个 TTS 引擎一致实现**：MiniMax(云端)、Edge TTS(云端免费)、Piper(本地)、Kokoro(ONNX)、Moss Nano，切换仅需配置
- **请求体大小限制**：`ttsMaxBodyBytes = 1MB` 防止超大文本攻击
