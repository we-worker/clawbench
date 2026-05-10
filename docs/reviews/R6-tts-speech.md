# R6: TTS 语音流程 Review

> 日期: 2026-05-10
> 审查范围: 文本 → 摘要压缩 → TTS引擎 → 音频响应 → 前端播放

## 审查范围

### 前端
- `web/src/composables/useAutoSpeech.ts` (327行) — 自动语音状态机、SSE连接、音频播放核心逻辑
- `web/src/components/media/AudioPreview.vue` (125行) — 音频文件预览播放器
- `web/src/components/chat/ChatMessageItem.vue` (TTS按钮部分, ~15行) — 朗读按钮UI与交互

### 后端API
- `internal/handler/tts.go` (306行) — TTS生成与SSE流式推送HTTP handler
- `internal/service/tts_runtime.go` (109行) — TTS任务运行时管理(注册/取消/事件分发)

### 接口
- `internal/speech/interface.go` (130行) — SpeechProvider接口、StripMarkdown工具函数

### 摘要器
- `internal/speech/summarizer.go` (188行) — Summarizer接口、genericSummarizer共享逻辑、语言映射
- `internal/speech/simple_summarizer.go` (31行) — 零AI开销的简单摘要器(仅去Markdown+截断)
- `internal/speech/mmx_summarizer.go` (69行) — mmx CLI摘要器
- `internal/speech/ai_backend_summarizer.go` (84行) — AI Backend摘要器(复用ai包的CLI后端)
- `internal/speech/ollama_summarizer.go` (133行) — Ollama HTTP API摘要器

### 引擎
- `internal/speech/minimax.go` (93行) — MiniMax云TTS引擎(mmx CLI)
- `internal/speech/edge_tts.go` (97行) — Edge TTS引擎(免费微软TTS)
- `internal/speech/piper.go` (161行) — Piper本地离线TTS引擎
- `internal/speech/kokoro.go` (142行) — Kokoro本地ONNX TTS引擎
- `internal/speech/moss_tts_nano.go` (159行) — MOSS-TTS-Nano本地ONNX TTS引擎

### 数据库
- `internal/service/database.go` (TTS缓存部分, ~25行) — tts_summaries表CRUD

### 配置
- `cmd/server/main.go` (TTS初始化部分, ~170行) — 摘要器与引擎的选择和配置
- `internal/model/config.go` (TTS配置结构, ~20行) — TTS相关配置结构体
- `internal/model/defaults.go` (TTS默认值, ~15行) — TTS配置默认值

## 三维度评估

### 🏗️ 架构设计 (30%)

**优点:**
1. **接口抽象清晰**: `SpeechProvider` 和 `Summarizer` 两个接口职责分明，各自仅一个方法，符合接口隔离原则。引擎和摘要器可以独立替换。
2. **genericSummarizer 模板方法模式**: 将共享的摘要流水线(短文本绕过 → 多轮摘要 → StripMarkdown安全网)提取到 `genericSummarizer`，各后端只需实现 `summarizePassFunc`，消除了重复代码。
3. **SSE+异步Job架构**: TTS生成采用 POST创建Job + EventSource消费结果 的模式，避免了长轮询，前端可以实时收到阶段进度。
4. **模块级单例前端状态**: `useAutoSpeech` 使用模块级 `ref` 共享状态，所有消费者共享同一个音频播放器，避免多实例冲突。

**问题:**
1. **handler包持有全局可变状态** (`tts.go:32-47`): `speechProvider` 和 `summarizer` 是包级 `var`，`SetSpeechProvider`/`SetSummarizer` 虽注释了"not goroutine-safe"，但没有运行时保护。如果未来支持热重载配置，会引入竞态。
2. **引擎扩展检测方式硬编码** (`tts.go:97-105`): 通过类型断言 `speechProvider.(*speech.PiperProvider)` 来决定音频文件扩展名，每增加一个输出 `.wav` 的引擎就需要加一个分支。违反开闭原则。
3. **摘要失败与合成失败混用同一字段** (`tts.go:163-168`): 当摘要失败时，发送的 `TTSEvent` 设置了 `SynthesizeFailed: true`，但语义上是摘要阶段失败，不是合成阶段失败。前端无法区分是哪一步出了问题。
4. **tts_runtime.go 放在 service 包不够内聚**: TTS 运行时管理（Job注册、事件分发）与数据库操作（`GetTTSSummary`）都在 `service` 包，但两者关注点不同。`tts_runtime.go` 更像是 TTS 领域逻辑，可以独立为 `tts` 子包。
5. **前端缺少摘要失败后的回退路径**: 当 `summarizeFailed=true` 时，前端仅显示 toast 提示，但没有尝试用原文调用 TTS。后端 `genericSummarizer` 失败时直接返回错误而非回退到 `SimpleSummarizer`。

### ✨ 代码质量 (30%)

**优点:**
1. **StripMarkdown 全面且分阶段**: 正则清理分5个阶段（转义→块级→行内→URL→空白），还有 `stripResidualMarkdown` 兜底，覆盖了 Markdown 语法的绝大多数情况。
2. **代码注释充分**: 每个常量、接口方法、公开函数都有清晰的注释，说明意图和默认值。
3. **错误信息一致**: 所有引擎的 `Synthesize` 方法返回格式化的错误（包含 stderr 输出），便于调试。
4. **前端状态机清晰**: `idle → summarizing → synthesizing → playing → idle` 的生命周期在注释中有明确说明。

**问题:**
1. **`needsReSummarization` 用字节而非字符数判断** (`summarizer.go:186`): `len(result) > reSummarizeThreshold` 计算的是字节数，但中文文本的 UTF-8 编码每个字符3字节，导致中文摘要比英文更容易触发二次摘要，行为不一致。
2. **`reInlineCode` 正则可能错误匹配** (`interface.go:23`): `` `[^`]+` `` 无法匹配含反引号的行内代码（如 `` `it`s` ``），且 `stripInlineCode` 中 `match[1:len-1]` 在单字符匹配时可能产生意外结果。
3. **MMXSummarizer 的 JSON 拼接不安全** (`mmx_summarizer.go:36`): `fmt.Sprintf('[{"role":"user","content":%q}]', text)` 使用 `%q` 转义，虽然 Go 的 `%q` 会处理引号，但手拼 JSON 不如 `json.Marshal` 安全直观。
4. **AIBackendSummarizer 未处理 "cancelled" 事件** (`ai_backend_summarizer.go:60-69`): 流中可能出现 `cancelled` 类型事件，但 `doSummarizePass` 只处理 `content`/`done`/`error`，其他事件被静默忽略。如果流被取消，可能永远不会收到 `done`，导致 channel 阻塞直到 context 取消。
5. **前端 `handleResult` 函数重复的状态清理代码** (`useAutoSpeech.ts:217-253`): `reportError` 后紧跟 `activeId.value = '' / playingSummary.value = '' / state.value = 'idle'` 这三行在6个地方重复出现，应提取为辅助函数。

### 🛡️ 健壮性 (40%)

**优点:**
1. **输出文件存在性验证**: 所有5个引擎在 `cmd.Run()` 后都通过 `os.Stat` 验证文件是否实际创建，防止 CLI 静默失败。
2. **请求体大小限制**: `ttsMaxBodyBytes = 1MB` 防止超大文本耗尽内存。
3. **摘要和合成都有超时**: `ttsSummarizeTimeout=60s` 和 `ttsSynthesizeTimeout=120s` 防止 CLI 进程无限挂起。
4. **前端音频资源清理**: `stopAudio()` 同时清理 `AbortController`、`EventSource` 和 `HTMLAudioElement`，避免了资源泄漏。
5. **SSE客户端断开自动取消**: `TTSStream` 监听 `r.Context().Done()` 并调用 `CancelTTSJob`，避免僵尸任务。

**问题:**
1. **P0 - SendTTSEvent 非阻塞丢事件** (`tts_runtime.go:62-76`): `SendTTSEvent` 使用 `select/default` 非阻塞写入，当 channel 缓冲区满时静默丢弃事件。如果 `result` 事件被丢弃，前端将永远收不到音频路径，导致 TTS 请求挂起。channel 容量仅16，在并发场景下可能不够。
2. **P1 - 缓存命中时摘要可能为空** (`tts.go:121-125`): 缓存命中后先查DB，再 fallback 到文件 `absAudioPath + ".summary.txt"`。但 `.summary.txt` 文件从未被写入——代码中只有 `SaveTTSSummary` 写DB，没有写 `.summary.txt` 的逻辑。这是遗留代码，文件读取永远不会成功但也不会报错。
3. **P1 - CloseTTSJobDone 与 UnregisterTTSJob 竞态** (`tts_runtime.go:79-95`): `CloseTTSJobDone` 先 `Load` 再检查 `job.Done`，而 `UnregisterTTSJob` 使用 `LoadAndDelete` 并关闭 `StreamCh`。如果两者并发执行，`CloseTTSJobDone` 可能在 job 被删除后操作已关闭的 channel。虽然当前调用顺序是 `defer UnregisterTTSJob → defer CloseTTSJobDone → defer cancel`，但 `CancelTTSJob`（SSE断开时调用）只取消 context 不删除 job，所以 `SendTTSEvent` 仍可能在 job 删除后写入已关闭的 channel（panic）。
4. **P1 - 重复请求竞态** (`tts.go:92-221`): 两个并发请求对相同文本（相同 cacheKey）会同时发现缓存不存在，各自启动后台 Job。后注册的 Job 会覆盖先注册的（`sync.Map.Store`），先注册的 Job 的 cancel func 和 Done channel 会泄漏。前端可能连到后注册的 Job，而先注册的 Job 的结果无人消费。
5. **P1 - EdgeTTS/Piper/Kokoro/MossNano 忽略 language 参数** (`edge_tts.go:40`, `piper.go:48`, `kokoro.go:54`, `moss_tts_nano.go:63`): 这些引擎的 `Synthesize` 方法签名包含 `language` 参数但用 `_` 忽略。Piper 的语音完全取决于模型文件，如果模型是英文的，传入中文文本也不会切换语言。用户配置中文摘要器 + 英文 Piper 模型时，会产生不匹配。
6. **P2 - Piper/Kokoro ModelPath 为空时到 Synthesize 才报错** (`piper.go:55-57`, `kokoro.go:61-63`): 在 `main.go` 初始化时，Piper 的 `ModelPath` 通过 `ResolveModelPath` 解析，但如果 `voice` 和 `modelPath` 都为空，`ResolveModelPath` 返回空字符串，直到第一次 `Synthesize` 调用才报错。应启动时校验。
7. **P2 - OllamaSummarizer HTTPClient 超时与 context 超时重叠** (`ollama_summarizer.go:39`): `HTTPClient.Timeout = 120s`，而 `ttsSummarizeTimeout = 60s`。如果 context 先超时，HTTP 请求会被取消，但 `HTTPClient.Timeout` 的计时器仍在运行。这不会造成功能问题，但 120s 的硬编码超时与外层 60s 超时不一致。
8. **P2 - 前端 EventSource 无超时机制** (`useAutoSpeech.ts:173`): SSE 连接建立后没有超时保护。如果后端 Job 卡在摘要或合成阶段，前端会永远等待。虽然 `AbortController` 允许用户手动取消，但缺乏自动超时。
9. **P2 - 缓存键不含语言和引擎信息** (`tts.go:92-93`): `sha256(text)[:16]` 作为缓存键，不包含 `language` 或引擎类型。如果用户切换语言或引擎后请求相同文本，会命中旧缓存返回错误语言的音频。
10. **P2 - tts_summaries 表无过期清理** (`database.go:130-134`): `tts_summaries` 表只写入不清理，随时间无限增长。虽然单条记录很小，但缺乏 `retention_days` 或定期清理机制。

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R6-001 | P0 | 健壮性 | SendTTSEvent 非阻塞丢事件，result事件丢失会导致前端永久挂起 | `tts_runtime.go:62-76` | 改为阻塞写入或增大缓冲区；对result事件必须保证送达，可使用独立的unbuffered result channel |
| R6-002 | P1 | 健壮性 | 缓存命中时读取 `.summary.txt` 文件的逻辑是死代码，该文件从未被写入 | `tts.go:123` | 移除文件读取的 fallback，仅依赖DB |
| R6-003 | P1 | 健壮性 | CloseTTSJobDone 与 UnregisterTTSJob 并发可能操作已关闭 channel 或对已删除 job 操作 | `tts_runtime.go:52-95` | 统一用 `LoadAndDelete` 原子操作；在 job 内部加 mutex 保护 close 逻辑 |
| R6-004 | P1 | 健壮性 | 相同文本的并发请求导致 Job 覆盖和 cancel func 泄漏 | `tts.go:134-221` | 在 RegisterTTSJob 前检查是否已存在相同 key 的 job，如存在返回现有 job |
| R6-005 | P1 | 架构 | 摘要失败时发送 SynthesizeFailed 事件，语义不准确，前端无法区分失败阶段 | `tts.go:163-168` | 在 TTSEvent 中添加 `SummarizeFailed` 字段，与 `SynthesizeFailed` 分离 |
| R6-006 | P1 | 健壮性 | Piper/Kokoro/MossNano/EdgeTTS 忽略 language 参数，可能导致文本与语音语言不匹配 | 各引擎 Synthesize 方法 | 在 Synthesize 中记录 warning；或在初始化时校验引擎与语言兼容性 |
| R6-007 | P2 | 质量 | needsReSummarization 用字节数而非字符数判断长度，中文文本更容易触发二次摘要 | `summarizer.go:186` | 改为 `len([]rune(result)) > threshold`，或按中文场景调整阈值 |
| R6-008 | P2 | 健壮性 | 缓存键 sha256(text)[:16] 不含 language 和引擎类型，切换后命中错误缓存 | `tts.go:92-93` | 缓存键加入 language 和引擎标识，如 `sha256(text+lang+engine)[:16]` |
| R6-009 | P2 | 架构 | 引擎扩展名检测通过类型断言硬编码，每加新引擎需改 handler | `tts.go:97-105` | 在 SpeechProvider 接口添加 `FileExtension() string` 方法，各引擎自行返回 |
| R6-010 | P2 | 健壮性 | Piper/Kokoro ModelPath 为空时延迟到 Synthesize 才报错 | `piper.go:55`, `kokoro.go:61` | 在 main.go 初始化后校验必需路径，启动时 fail-fast |
| R6-011 | P2 | 健壮性 | OllamaSummarizer HTTPClient 120s 超时与外层 60s 超时不一致 | `ollama_summarizer.go:39` | 将 HTTPClient 超时与 ttsSummarizeTimeout 对齐，或去掉客户端超时仅依赖 context |
| R6-012 | P2 | 健壮性 | 前端 EventSource 连接无超时保护，后端卡住时前端永远等待 | `useAutoSpeech.ts:173` | 添加 60s-120s 的超时定时器，超时后自动 abort 并报错 |
| R6-013 | P2 | 健壮性 | tts_summaries 表无过期清理机制，数据无限增长 | `database.go:130-134` | 复用 CleanupWorker 机制，按 created_at 清理过期摘要 |
| R6-014 | P2 | 质量 | MMXSummarizer 手拼 JSON 而非 json.Marshal | `mmx_summarizer.go:36` | 改用 `json.Marshal` 构建请求体，更安全且易读 |
| R6-015 | P2 | 质量 | 前端 handleResult 中状态清理代码重复6次 | `useAutoSpeech.ts:217-253` | 提取 `resetState()` 辅助函数 |
| R6-016 | P2 | 架构 | handler 包持有全局可变 speechProvider/summarizer，无运行时保护 | `tts.go:32-47` | 封装到 struct 中，通过依赖注入传入 handler |
| R6-017 | P2 | 架构 | AIBackendSummarizer 未处理 cancelled 事件，流取消时可能阻塞 | `ai_backend_summarizer.go:60-69` | 添加 `case "cancelled"` 处理，返回 context.Canceled 错误 |
| R6-018 | P3 | 质量 | StripMarkdown 的 reResidualMarkdown 正则 `[\\#*~`|]` 会误删合法内容（如数学符号×、中文名中的·） | `interface.go:110` | 仅在文本经过完整 Markdown 处理后对残留标点清理，或缩小正则范围 |
| R6-019 | P3 | 改进 | MiniMaxProvider 的 TTSModel 默认值 "speech-2.8-hd" 与 config 注释 "Speech-2.8-Turbo" 不一致 | `minimax.go:29` vs `config.go:38` | 统一默认模型名称 |
| R6-020 | P3 | 改进 | 前端 speakMessage 检查 enabled 但 speakText 不检查，两个函数行为不一致 | `useAutoSpeech.ts:276-283` | 在注释中明确 speakText 是手动触发（不受 toggle 限制），或统一检查 |

## 改进建议 (Top 3)

1. **修复 SendTTSEvent 事件丢失风险**: 将 `result` 事件改为必须送达（阻塞写入或独立 channel），当前非阻塞写入在 channel 满时会静默丢弃 `result` 事件，导致前端永久挂起。这是唯一一个 P0 级问题，影响生产可靠性。预期收益: 消除 TTS 请求偶发挂起的隐患。

2. **缓存键加入语言和引擎维度**: 当前 `sha256(text)[:16]` 在切换语言或引擎后仍命中旧缓存，用户会听到错误语言的音频。改为 `sha256(text+language+engine)[:16]`。同时移除 `.summary.txt` 文件读取的死代码。预期收益: 修复多语言/多引擎场景下的缓存正确性。

3. **统一 TTS 运行时的并发安全模型**: 解决 CloseTTSJobDone/UnregisterTTSJob/CancelTTSJob 三者间的竞态风险，以及重复请求导致的 Job 覆盖和 cancel 泄漏。建议将 TTS 运行时封装为独立 struct（含 mutex），提供 `RegisterOrGet` 原子操作，确保同 ID job 只创建一次。预期收益: 消除并发场景下的竞态条件和资源泄漏。

## 亮点

- **genericSummarizer 模板方法设计优秀**: 将多轮摘要、短文本绕过、StripMarkdown 安全网等共享逻辑统一封装，各后端仅需实现一个 `summarizePassFunc`，零代码重复。
- **前端状态机设计清晰**: `idle → summarizing → synthesizing → playing → idle` 四态模型，配合模块级单例，所有消费者共享一致的 UI 状态。
- **引擎实现一致性高**: 所有5个引擎都遵循相同的模式（创建目录 → 构建 CLI 参数 → 执行 → 验证输出），错误处理格式统一。
- **StripMarkdown 全面且防御性强**: 5阶段清理 + 残留兜底，几乎覆盖所有 Markdown 语法，确保 TTS 输入干净。
- **零配置默认值设计**: 默认使用 Edge TTS（免费）+ Simple 摘要器（零延迟），用户无需配置即可使用，高级用户可逐步切换到 AI 摘要+高质量引擎。
