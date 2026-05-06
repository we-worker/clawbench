# ClawBench 全面代码 Review 汇总索引

> 日期: 2026-05-24
> 审查范围: R1-R12 共12个流程，~200个文件，~40,000行代码
> 审查方式: 逐行精读，三维度评估（架构30% + 质量30% + 健壮性40%）

---

## 各流程 Review 文件

| 编号 | 流程 | 文件 | 评分 |
|------|------|------|------|
| R1 | Chat 主流程 | [R1-chat-main-flow.md](R1-chat-main-flow.md) | 🏗️7.8 ✨7.4 🛡️7.2 |
| R2 | SSE 流式传输 | [R2-sse-streaming.md](R2-sse-streaming.md) | 🏗️8.0 ✨7.5 🛡️7.0 |
| R3 | Auto-Resume 流程 | [R3-auto-resume.md](R3-auto-resume.md) | 🏗️8.5 ✨8.0 🛡️7.9 |
| R4 | Session 管理 | [R4-session-management.md](R4-session-management.md) | 🏗️8.2 ✨7.5 🛡️7.3 |
| R5 | 定时任务流程 | [R5-scheduled-tasks.md](R5-scheduled-tasks.md) | 🏗️7.0 ✨7.0 🛡️5.0 |
| R6 | TTS 语音流程 | [R6-tts-voice.md](R6-tts-voice.md) | 🏗️8.0 ✨7.5 🛡️7.0 |
| R7 | SSH/端口转发 | [R7-ssh-port-forwarding.md](R7-ssh-port-forwarding.md) | 🏗️8.0 ✨7.5 🛡️6.5 |
| R8 | 文件管理流程 | [R8-file-management.md](R8-file-management.md) | 🏗️7.5 ✨7.0 🛡️6.5 |
| R9 | Git 历史流程 | [R9-git-history.md](R9-git-history.md) | 🏗️8.5 ✨8.0 🛡️7.5 |
| R10 | 认证流程 | [R10-authentication.md](R10-authentication.md) | 🏗️7.5 ✨7.5 🛡️6.0 |
| R11 | 配置/默认值 | [R11-config-defaults.md](R11-config-defaults.md) | 🏗️8.0 ✨7.5 🛡️7.0 |
| R12 | Android Bridge | [R12-android-bridge.md](R12-android-bridge.md) | 🏗️7.5 ✨7.0 🛡️6.0 |

---

## P0 问题总表

| ID | 流程 | 描述 | 文件:行号 |
|----|------|------|-----------|
| R1-001 | R1 Chat | CancelSession 与 goroutine defer 的 close-after-write 竞态，可导致 send-on-closed-channel panic | `session_runtime.go:99-113` |
| R1-002 | R1 Chat | SSE 事件 JSON.parse 无 try-catch，畸形数据导致整个 stream 崩溃 | `useChatStream.ts:249,265,279` |
| R2-001 | R2 SSE | 重连后 SSE 事件丢失无补偿 | `useChatStream.ts` 重连逻辑 |
| R5-001 | R5 定时任务 | Cron 任务无并发保护，同一任务可重叠执行 | `scheduler.go:217-224` |
| R5-002 | R5 定时任务 | schedule-proposal 自动创建任务无用户确认，AI 可构造恶意 cron | `chat.go:897-909` |
| R5-003 | R5 定时任务 | TriggerTask 无 running 检查，手动触发可与自动执行并发 | `scheduler.go:140-147` |
| R6-001 | R6 TTS | SendTTSEvent 非阻塞写入，channel 满时 result 事件被 drop | `service/` TTS Job 管理 |
| R6-002 | R6 TTS | CloseTTSJobDone 和 CancelTTSJob 并发关闭 Done channel | `service/` TTS Job 管理 |
| R7-001 | R7 SSH | `/api/ssh/info` 无需认证，暴露 SSH 端口和指纹 | `handler.go:207` |
| R7-002 | R7 SSH | SSH Server 无最大并发连接数限制 | `server.go:209-222` |
| R8-001 | R8 文件 | Rename/Delete 操作的 BasePath 客户端可控，可操作项目内任意文件 | `file_ops.go` |
| R8-002 | R8 文件 | 符号链接绕过路径验证，可读取项目外文件 | `file.go`, `path.go` |
| R9-001 | R9 Git | SHA 参数未验证格式，可传入 flag-like 值 | `git.go:281` |
| R10-001 | R10 认证 | 密码哈希使用 SHA-256 + 硬编码盐 | `main.go:383` |
| R10-002 | R10 认证 | 全局共享 session token，不支持多会话和单独吊销 | `model/config.go` |
| R12-001 | R12 Bridge | Bridge 密码明文传输，可被同源 JS 窃取/篡改 | `LoginView.vue:47-48`, `App.vue:578-590` |

**P0 问题总数: 16**

---

## P1 问题总表

| ID | 流程 | 描述 |
|----|------|------|
| R1-003 | R1 Chat | CLI 子进程的孙进程不被 SIGKILL 清理，产生孤儿进程 |
| R1-004 | R1 Chat | UnregisterSessionStream close channel 后 goroutine 继续写会 panic |
| R1-005 | R1 Chat | queue_consume 事件 push 后 lastIndex 闭包变量与实际数组不一致 |
| R1-006 | R1 Chat | useAutoSpeech 中 onerror 和 result 事件双重调用 handleResult |
| R1-007 | R1 Chat | useFileUpload 的 XHR 请求在组件卸载后不会 abort |
| R1-008 | R1 Chat | deleteSession 后 createSession() 失败时状态不一致 |
| R2-002 | R2 SSE | 重连计数器双重路径叠加 |
| R2-003 | R2 SSE | 轮询降级后 interval 未清理 |
| R4-001 | R4 Session | CancelSession 与 goroutine defer 的竞态（与 R1-001 同源） |
| R4-002 | R4 Session | Dequeue/Enqueue 与 Delete 的 sessionQueues 并发操作 |
| R4-003 | R4 Session | deleteSession 后 createSession 失败时状态不一致（与 R1-008 同源） |
| R5-004 | R5 定时任务 | executeTask 无超时，CLI 可能永久挂起 |
| R5-005 | R5 定时任务 | DB.Exec 返回值全局性忽略 |
| R5-006 | R5 定时任务 | UpdateTask 中 registerTaskLocked 和 saveTask 非原子 |
| R5-007 | R5 定时任务 | serveTaskExecutions 缺少分页 |
| R5-008 | R5 定时任务 | cron 表达式验证不充分 |
| R6-003 | R6 TTS | 摘要失败无降级，用户无法听到任何语音 |
| R6-004 | R6 TTS | EventSource onerror 和 result 事件双重调用（与 R1-006 同源） |
| R6-005 | R6 TTS | SSE 断连后 synthesize 阶段可能不响应 cancel |
| R7-003 | R7 SSH | SSH 密码与 HTTP 认证共用，明文存储 |
| R7-004 | R7 SSH | 健康检查 goroutine 可能泄漏 |
| R7-005 | R7 SSH | handleDirectTCPIP 的 backend dial 无超时 |
| R8-003 | R8 文件 | 上传文件名未做 sanitize |
| R8-004 | R8 文件 | 大文件全量加载到内存 |
| R9-002 | R9 Git | 文件历史无分页 |
| R9-003 | R9 Git | 大 diff 无大小限制 |
| R9-004 | R9 Git | 搜索全量加载全部 commit |
| R10-003 | R10 认证 | 无登录速率限制 |
| R10-004 | R10 认证 | 无 CSRF 保护 |
| R10-005 | R10 认证 | Android 自动登录密码明文传输（与 R12-001 同源） |
| R10-006 | R10 认证 | 自动密码明文输出到 stdout |
| R11-001 | R11 配置 | 硬编码盐值 + SHA-256 弱哈希（与 R10-001 同源） |
| R11-002 | R11 配置 | 自动密码明文输出到 stdout（与 R10-006 同源） |
| R12-002 | R12 Bridge | Bridge 检测异常无降级提示 |
| R12-003 | R12 Bridge | getPassword 无访问控制 |

**P1 问题总数: 35**

---

## 跨流程共性问题

### 1. 并发安全缺陷（5个流程受影响）
**模式**：`sync.Map`/`sync.Mutex` 保护的部分状态与未保护的状态交叉使用，导致竞态条件
- **R1/R4**: CancelSession 与 goroutine defer 的 channel close/write 竞态
- **R5**: Cron 任务无并发执行保护
- **R6**: TTS Job 的 Done channel 并发 close
- **R7**: SSH Server 无最大连接数限制
- **R8**: 文件操作非原子性

**根因**：缺少统一的并发控制模式。每个子系统独立设计锁策略，跨子系统操作时锁不覆盖。

### 2. 密码/认证安全薄弱（4个流程受影响）
**模式**：SHA-256 + 硬编码盐、明文密码传输、全局共享 token
- **R10**: 密码哈希使用 SHA-256 + 硬编码盐
- **R11**: 同上（同源问题）
- **R12**: Bridge 密码明文传输
- **R10**: 无登录速率限制、无 CSRF 保护

**根因**：认证系统设计时优先考虑了零配置和简易部署，安全加固不足。

### 3. 事件/消息丢失（3个流程受影响）
**模式**：非阻塞 channel 发送 + 无补偿机制
- **R1**: SSE channel full 时 drop event
- **R2**: 重连后 SSE 事件丢失无补偿
- **R6**: TTS result 事件被 drop

**根因**：统一使用 `select + default` 非阻塞发送避免 goroutine 阻塞，但缺少事件丢失的检测和补偿机制。

### 4. 资源泄漏（5个流程受影响）
**模式**：goroutine/进程/channel 的生命周期管理不完整
- **R1**: CLI 孙进程不被清理
- **R1**: XHR 请求组件卸载后不 abort
- **R5**: executeTask 无超时
- **R6**: synthesize 阶段不响应 cancel
- **R7**: 健康检查 goroutine 可能泄漏

**根因**：context cancel 不保证所有下游资源被清理，缺少统一的资源生命周期管理框架。

### 5. 路径安全边界（3个流程受影响）
**模式**：路径验证逻辑可被符号链接或客户端可控参数绕过
- **R8**: 符号链接绕过路径验证
- **R8**: BasePath 客户端可控
- **R9**: SHA 参数未验证格式

**根因**：`validateAndResolvePath` 基于 `filepath.Abs` + `strings.HasPrefix`，不解析符号链接；部分 API 接受客户端可控的路径参数。

### 6. 全局可变状态（4个流程受影响）
**模式**：包级全局变量（`sync.Map`、`var`）持有运行时状态
- **R1/R4**: `activeSessions`, `sessionStreams`, `sessionCancels`
- **R5**: `GlobalScheduler`
- **R6**: `speechProvider`, `summarizer`
- **R10**: `model.SessionToken`

**根因**：Go 的包级变量是最简单的状态共享方式，但无法多实例化、难以测试、生命周期管理困难。

---

## 优先修复排序

### 第一优先级：安全漏洞（1-2周内修复）

| # | 问题 | 影响范围 | 修复难度 | 预期收益 |
|---|------|---------|---------|---------|
| 1 | R10-001: 密码哈希迁移到 bcrypt | 全局认证 | 低 | 消除密码破解风险 |
| 2 | R8-001+R8-002: 文件操作路径安全 | 文件系统 | 中 | 消除任意文件操作风险 |
| 3 | R5-002: schedule-proposal 需用户确认 | 定时任务 | 低 | 消除 AI 恶意创建任务风险 |
| 4 | R7-001: SSH info 端点加认证 | SSH 服务 | 低 | 消除信息泄露 |
| 5 | R12-001: Bridge 密码明文传输 | Android App | 中 | 消除密码窃取风险 |

### 第二优先级：数据丢失/崩溃（2-4周内修复）

| # | 问题 | 影响范围 | 修复难度 | 预期收益 |
|---|------|---------|---------|---------|
| 6 | R1-001: channel close/write 竞态 | Chat 核心链路 | 中 | 消除 send-on-closed-channel panic |
| 7 | R1-002: SSE 事件 JSON.parse 防护 | Chat 核心链路 | 低 | 消除 stream 崩溃 |
| 8 | R5-001: Cron 任务并发保护 | 定时任务 | 低 | 消除任务重叠执行 |
| 9 | R6-001+R6-002: TTS Job 事件投递和并发安全 | TTS 系统 | 低 | 消除 TTS 结果丢失 |
| 10 | R1-003: CLI 孙进程清理 | AI 执行 | 中 | 消除孤儿进程 |

### 第三优先级：可靠性提升（1-2个月内修复）

| # | 问题 | 影响范围 | 修复难度 | 预期收益 |
|---|------|---------|---------|---------|
| 11 | R2-001: 重连后事件丢失补偿 | SSE 传输 | 中 | 消除重连后消息缺失 |
| 12 | R5-004: executeTask 超时兜底 | 定时任务 | 低 | 消除 CLI 挂死 |
| 13 | R9-001: SHA 参数格式验证 | Git 操作 | 低 | 消除 git flag 注入 |
| 14 | R10-003+R10-004: 登录速率限制 + CSRF | 认证系统 | 中 | 防止暴力破解和 CSRF |
| 15 | R7-002: SSH 最大并发连接数 | SSH 服务 | 低 | 防止资源耗尽 |

---

## 架构级系统性改进建议

### 1. 引入统一的并发安全框架

**当前问题**：每个子系统独立管理并发状态（`sync.Map`/`sync.Mutex`），跨子系统操作时锁不覆盖，导致竞态条件。

**建议**：
- 引入 `Runtime` struct 持有所有运行时状态（`activeSessions`、`sessionStreams`、`sessionCancels`、`sessionQueues`），替代包级全局变量
- 使用 `context.Context` 链传递取消信号，而非单独管理 `sessionCancels`
- 为所有 channel 操作引入 `sendEvent` 统一方法（含 atomic flag 检查 + recover from panic）

### 2. 认证系统重构

**当前问题**：SHA-256 + 硬编码盐、全局共享 token、无 CSRF 保护、Bridge 密码明文。

**建议**：
- 密码存储改用 `bcrypt`
- Session token 改为 `crypto/rand` 生成的独立随机值，支持多会话和单会话吊销
- 添加登录速率限制（IP 级 rate limiter）
- 添加 CSRF token 或升级 SameSite 到 Strict
- Android Bridge 实现 `autoLogin()` 接口，消除密码明文传递

### 3. 事件可靠性保障

**当前问题**：非阻塞 channel 发送 + 无补偿机制导致事件丢失。

**建议**：
- 为关键事件（`result`、`resume_split`、`done`）使用保证投递的发送方式（阻塞发送或重试）
- 在 SSE 协议层添加 sequence number，前端检测 gap 后主动从 DB 补齐
- 重连时使用 `Last-Event-ID` header 让后端续发缺失事件

### 4. 路径安全加固

**当前问题**：`validateAndResolvePath` 不解析符号链接，部分 API 接受客户端可控路径参数。

**建议**：
- 在 `validateAndResolvePath` 中使用 `filepath.EvalSymlinks` 解析符号链接后再验证
- 为文件操作 API 添加目录白名单或黑名单（禁止操作 `.clawbench/`、`.git/`）
- 对用户上传的文件名做 sanitize（移除路径分隔符、空字节、限制长度）
- 对所有用户可控的标识符参数（SHA、sessionID、jobID）添加格式校验

### 5. 资源生命周期管理

**当前问题**：goroutine/进程/channel 的生命周期管理不完整，context cancel 不保证所有下游资源被清理。

**建议**：
- CLI 后端使用进程组（`SysProcAttr{Setpgid: true}`）确保孙进程被清理
- 为所有长时运行操作添加超时兜底（定时任务 30min、TTS synthesize 2min）
- 统一使用 `context.WithTimeout` + `context.WithCancel` 组合，而非裸 `context.Background()`
- 添加全局 goroutine 泄漏检测（如 `runtime.NumGoroutine()` 监控）

---

## 统计概览

| 指标 | 数值 |
|------|------|
| 审查流程数 | 12 |
| 审查文件数 | ~200 |
| 审查代码行数 | ~40,000 |
| P0 问题数 | 16 |
| P1 问题数 | 35 |
| P2 问题数 | ~50 |
| P3 问题数 | ~30 |
| 跨流程共性问题 | 6 类 |
| 架构级改进建议 | 5 项 |
| 最脆弱流程 | R5 定时任务（健壮性 5.0/10） |
| 最健壮流程 | R3 Auto-Resume（健壮性 7.9/10） |
