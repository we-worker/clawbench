# ClawBench 全面代码 Review 汇总索引

> 生成日期: 2026-05-10
> 审查范围: R1-R12 共12个流程，约150个核心文件，逐行精读
> 执行方式: 12个并行Review代理，每个代理独立逐行精读+三维度分析

## Review 文件索引

| 编号 | 流程 | 文件 | P0 | P1 | P2 | P3 | 总计 |
|------|------|------|----|----|----|----|------|
| R1 | Chat 主流程 | [R1-chat-main-flow.md](R1-chat-main-flow.md) | 0 | 3 | 11 | 6 | 20 |
| R2 | SSE 流式传输 | [R2-sse-streaming.md](R2-sse-streaming.md) | 3 | 6 | 9 | 3 | 21 |
| R3 | Auto-Resume | [R3-auto-resume.md](R3-auto-resume.md) | 0 | 2 | 8 | 2 | 12 |
| R4 | Session 管理 | [R4-session-management.md](R4-session-management.md) | 1 | 5 | 11 | 4 | 23* |
| R5 | 定时任务 | [R5-scheduled-tasks.md](R5-scheduled-tasks.md) | 3 | 7 | 9 | 3 | 22 |
| R6 | TTS 语音 | [R6-tts-speech.md](R6-tts-speech.md) | 1 | 5 | 12 | 3 | 20* |
| R7 | SSH/端口转发 | [R7-ssh-proxy.md](R7-ssh-proxy.md) | 3 | 6 | 8 | 3 | 20 |
| R8 | 文件管理 | [R8-file-management.md](R8-file-management.md) | 5 | 6 | 6 | 0 | 17 |
| R9 | Git 历史 | [R9-git-history.md](R9-git-history.md) | 1 | 6 | 8 | 5 | 20 |
| R10 | 认证 | [R10-authentication.md](R10-authentication.md) | 1 | 7 | 9 | 5 | 22 |
| R11 | 配置/默认值 | [R11-config-defaults.md](R11-config-defaults.md) | 0 | 2 | 6 | 5 | 15* |
| R12 | Android Bridge | [R12-android-bridge.md](R12-android-bridge.md) | 5 | 6 | 7 | 5 | 23 |
| **合计** | | | **22** | **61** | **102** | **44** | **229** |

> \* 部分review问题数含子分类

---

## P0 问题总表（22个 — 必须修复）

| ID | 流程 | 描述 | 文件:行号 |
|----|------|------|-----------|
| R2-001 | SSE | JSON.parse无try-catch，8处SSE事件解析无防护，畸形数据杀死事件监听器 | `useChatStream.ts:247,263,277,334,349,422,454` |
| R2-002 | SSE | reconnectAttempts计数器失效，MAX_RECONNECT_ATTEMPTS=3实际等于1 | `useChatStream.ts:198` |
| R2-003 | SSE | error事件catch回调中JSON.parse无防护+blocks替换后遍历无效 | `useChatStream.ts:491,496-499` |
| R4-001 | Session | `useSessionIdentity.createSession` fallback路径引用闭包外`agents`变量，运行时ReferenceError | `useSessionIdentity.ts:139` |
| R5-001 | 定时任务 | Cron回调无并发保护，同一任务可重叠执行 | `scheduler.go:322-328` |
| R5-002 | 定时任务 | TriggerTask的TOCTOU竞态 | `handler/scheduler.go:158-169` |
| R5-003 | 定时任务 | 任务执行无超时，CLI挂死时goroutine永不退出 | `scheduler.go:405-406` |
| R6-001 | TTS | SendTTSEvent非阻塞丢事件，result事件丢失致前端永久挂起 | `tts_runtime.go:62-76` |
| R7-001 | SSH | SSH SSRF漏洞：HostToConnect未验证，可连接任意主机 | `server.go:336-383` |
| R7-002 | SSH | Backend dial无超时，不可达后端导致goroutine无限阻塞 | `server.go:384` |
| R7-003 | SSH | 密码比较使用==，存在时序侧信道攻击 | `server.go:172` |
| R8-001 | 文件 | MarkdownPreview v-html sanitize:false导致XSS | `MarkdownPreview.vue:4,100` |
| R8-002 | 文件 | 符号链接绕过validateAndResolvePath，可访问项目外文件 | `model/path.go:15-21` |
| R8-003 | 文件 | Rename/Delete BasePath客户端可控，可操作任意目录 | `file_ops.go:24-25,134` |
| R8-004 | 文件 | 上传扩展名黑名单缺少.html/.svg，构成存储型XSS | `upload.go:58-62` |
| R8-005 | 文件 | 10MB文件全量读入内存后JSON编码，峰值20MB | `file.go:187-209` |
| R9-001 | Git | SHA参数未校验格式，恶意值可能被git命令误解 | `git.go:244,273-281` |
| R10-001 | 认证 | Cookie缺少Secure标志，HTTPS部署下可被中间人截获 | `auth.go:40-47` |
| R12-001 | Android | getPassword()返回明文密码到JS层，同源iframe可窃取 | `App.vue:579` |
| R12-002 | Android | 密码明文通过HTTP传输 | `App.vue:583-586` |
| R12-003 | Android | LoginView绕过iframe守卫直接访问Bridge | `LoginView.vue:74-75` |
| R12-004 | Android | setSSHPassword明文存储SharedPreferences | `LoginView.vue:75` |

### P0 按风险域分类

| 风险域 | 数量 | 问题ID |
|--------|------|--------|
| **安全漏洞（XSS/SSRF/注入）** | 8 | R7-001, R8-001, R8-002, R8-003, R8-004, R9-001, R12-001, R12-003 |
| **密码/认证安全** | 4 | R7-003, R10-001, R12-002, R12-004 |
| **数据丢失/挂起** | 4 | R2-001, R2-002, R6-001, R4-001 |
| **资源耗尽** | 3 | R5-003, R7-002, R8-005 |
| **并发竞态** | 3 | R2-003, R5-001, R5-002 |

---

## P1 问题总表（61个 — 应尽快修复）

### 安全类 (18个)
| ID | 流程 | 描述 |
|----|------|------|
| R1-007 | Chat | session cookie无HttpOnly |
| R4-005 | Session | Cookie HttpOnly:false，XSS可窃取Session ID |
| R4-003 | Session | DeleteSession不检查Session是否正在运行 |
| R5-010 | 定时任务 | 反递归仅依赖环境变量，CLI工具可绕过 |
| R7-004 | SSH | 无最大并发SSH连接数限制 |
| R7-005 | SSH | 无每连接channel限制 |
| R7-006 | SSH | /api/ssh/info无需认证暴露SSH信息 |
| R7-007 | SSH | 空AllowedPorts=允许所有端口 |
| R7-008 | SSH | SSH密码与HTTP认证共用，明文存储 |
| R8-006 | 文件 | 上传文件名TOCTOU竞态 |
| R8-007 | 文件 | os.RemoveAll跟随符号链接 |
| R8-011 | 文件 | 上传文件名清理不完整 |
| R10-002 | 认证 | 无Session撤销机制 |
| R10-005 | 认证 | 固定盐"clawbench-salt"硬编码 |
| R10-006 | 认证 | 反向代理场景下localhost绕过可能意外生效 |
| R10-008 | 认证 | 无登录速率限制 |
| R11-001 | 配置 | 密码哈希使用硬编码盐值 |
| R12-005 | Android | localhost硬编码远程断连 |

### 可靠性类 (25个)
| ID | 流程 | 描述 |
|----|------|------|
| R1-001 | Chat | sendEvent静默丢SSE事件 |
| R1-002 | Chat | CancelSession与goroutine defer竞态 |
| R1-003 | Chat | 前端lastIndex闭包陈旧 |
| R2-004 | SSE | ForceCancelSession是dead code |
| R2-005 | SSE | Channel close始终emit done，无法区分正常完成和ForceCancel |
| R2-006 | SSE | AccumulateBlock无条件覆盖tool_use Input |
| R2-007 | SSE | 无服务端SSE心跳 |
| R2-008 | SSE | checkTicker竞态窗口 |
| R2-009 | SSE | cancelled事件非阻塞发送可能被drop |
| R3-001 | Auto-Resume | resume_split后AddChatMessage失败导致Phase2 goroutine泄漏 |
| R3-002 | Auto-Resume | Phase1→2切换窗口外层ctx取消可能误标cancelled |
| R4-002 | Session | ForceCancelSession不清理activeSessions和sessionStreams |
| R4-004 | Session | CancelSession可能产生双重终端SSE事件 |
| R5-004 | 定时任务 | limited repeat模式run_count竞态 |
| R5-005 | 定时任务 | UpdateTask非原子（先改内存再存DB） |
| R5-006 | 定时任务 | DB.Exec返回值系统性忽略（5处） |
| R5-007 | 定时任务 | 执行历史无分页 |
| R5-008 | 定时任务 | max_runs=0时limited模式永不完成 |
| R5-009 | 定时任务 | cron.ParseStandard错误静默忽略 |
| R6-002 | TTS | 缓存命中时.summary.txt读取是死代码 |
| R6-003 | TTS | CloseTTSJobDone/UnregisterTTSJob并发竞态 |
| R6-004 | TTS | 相同文本并发请求导致Job覆盖 |
| R7-009 | SSH | io.Copy无idle deadline |
| R8-008 | 文件 | ServeFileEditLine无文件大小检查 |
| R8-009 | 文件 | 非原子文件写入，crash时可能丢失数据 |

### 质量/架构类 (18个)
| ID | 流程 | 描述 |
|----|------|------|
| R4-006 | Session | auto-create逻辑在3处重复 |
| R5-010 | 定时任务 | 反递归仅依赖环境变量 |
| R6-005 | TTS | 摘要失败发送SynthesizeFailed语义不准确 |
| R6-006 | TTS | Piper/Kokoro/EdgeTTS/MossNano忽略language参数 |
| R8-010 | 文件 | 重复扩展名列表需手动同步3处 |
| R9-002 | Git | skip参数无上限 |
| R9-004 | Git | 搜索时全量加载所有commits |
| R9-005 | Git | gitDiff无输出大小限制 |
| R9-008 | Git | fetch竞态 |
| R9-010 | Git | nil parents slice→JSON null |
| R9-011 | Git | merge commit diff-tree -m产生重复文件条目 |
| R9-022 | Git | git命令执行错误被静默忽略 |
| R10-003 | 认证 | 密码哈希逻辑重复 |
| R10-004 | 认证 | Cookie验证逻辑重复 |
| R10-007 | 认证 | JSON解码忽略错误 |
| R11-003 | 配置 | rand.Read错误被忽略 |
| R12-006 | Android | Bridge调用无try/catch |
| R12-007 | Android | 一次性Bridge检测无重试 |

---

## 跨流程共性问题

### 1. 安全：路径遍历/XSS防护不完整（R7+R8+R9）
- `filepath.Abs`不解析symlink（R8-002），SHA参数未校验（R9-001），MarkdownPreview禁用sanitize（R8-001）
- **根因**：路径验证统一用`ValidatePath`但未用`EvalSymlinks`；前端markdown渲染信任所有内容
- **建议**：`ValidatePath`加`EvalSymlinks`；前端所有`v-html`启用DOMPurify；后端所有用户输入参数加格式校验

### 2. 安全：密码/认证链薄弱（R7+R10+R11+R12）
- 固定盐哈希（R10-005/R11-001）、时序侧信道（R7-003）、明文传输（R12-002）、SharedPreferences明文存储（R12-004）
- **根因**：项目定位为单用户本地工具，认证安全基线较低
- **建议**：短期修复时序侧信道（`ConstantTimeCompare`）+条件设置Secure标志；中期实现autoLogin接口消除JS层密码暴露；长期考虑bcrypt

### 3. 健壮性：非阻塞Channel发送丢事件（R1+R2+R3+R6）
- `sendEvent`（R1-001）、`SendSessionEvent`（R2-009）、`forwardEvent`（R3-006）、`SendTTSEvent`（R6-001）均使用`select/default`非阻塞发送
- **根因**：统一采用"丢弃优于阻塞"策略防止背压，但对关键控制事件（done/cancelled/result）丢弃后果严重
- **建议**：区分关键事件（阻塞发送+超时）和普通事件（非阻塞丢弃）；增大channel buffer

### 4. 健壮性：并发竞态缺乏原子保护（R4+R5）
- `ForceCancelSession`不清理运行时状态（R4-002）、`TriggerTask` TOCTOU（R5-002）、Cron回调无并发保护（R5-001）、`CloseTTSJobDone`/`UnregisterTTSJob`竞态（R6-003）
- **根因**：sync.Map原子操作粒度不够——检查和操作之间缺少原子保证
- **建议**：使用`LoadOrStore` CAS模式、引入状态机约束、关键路径用mutex保护复合操作

### 5. 质量：代码重复/逻辑散布（R1+R4+R10）
- 密码哈希重复2处（R10-003）、Cookie验证重复2处（R10-004）、auto-create重复3处（R4-006）、ask-question解析重复3处（R1-010）、扩展名列表重复3处（R8-010）
- **根因**：缺乏共享工具函数，各handler/composable独立实现相同逻辑
- **建议**：提取`model.HashPassword()`、`model.ValidateSessionCookie()`、`getOrCreateSession()`等共享函数

### 6. 质量：chat.go职责过重（R1+R4+R5）
- 1025行文件包含HTTP处理、流执行、队列管理、resume处理、ask-question转换
- **根因**：handler层承担了过多service层逻辑
- **建议**：将`executeStreamRun`/`finalizeStreamRun`移至service层，handler仅做HTTP协议适配

### 7. 健壮性：DB错误系统性忽略（R4+R5+R11）
- 5处`DB.Exec`不检查err（R5-006）、`os.MkdirAll/os.WriteFile`错误忽略（R11-004）、`rand.Read`错误忽略（R11-003）
- **根因**：早期开发中对SQLite操作的容错假设（"SQLite不太会失败"）
- **建议**：所有DB写操作至少检查err并log；关键路径return error给调用方

### 8. 前端：Bridge/原生交互安全薄弱（R12）
- 5个P0问题中4个与Android Bridge密码安全相关
- **根因**：Bridge设计初期未考虑安全威胁模型（JS层可访问密码、iframe共享Bridge）
- **建议**：实现`autoLogin`接口让Native层完成认证，密码不经过JS/HTTP

---

## 优先修复排序

### 🔴 紧急（P0 — 1周内）
1. **R8-001+R8-002+R8-003+R8-004** — 文件管理安全核心（XSS+路径遍历+BasePath绕过+上传XSS）— 5个P0打包修复
2. **R7-001+R7-002+R7-003** — SSH安全三连（SSRF+dial超时+时序侧信道）— 3个P0打包修复
3. **R2-001+R2-002+R2-003** — SSE健壮性（JSON.parse防护+reconnectAttempts+error事件）— 3个P0打包修复
4. **R5-001+R5-002+R5-003** — 定时任务并发安全（Cron保护+TriggerTask原子性+执行超时）— 3个P0打包修复
5. **R4-001** — `useSessionIdentity.createSession`闭包Bug — 唯一P0运行时Bug
6. **R6-001** — SendTTSEvent事件丢失 — TTS功能可靠性

### 🟠 高优先（P1 安全类 — 2周内）
7. **R10-001** — Cookie Secure标志条件设置
8. **R12-001+R12-002+R12-003+R12-004** — Android Bridge密码安全（autoLogin+加密存储+iframe守卫）
9. **R9-001** — SHA参数格式校验
10. **R7-004+R7-005+R7-006+R7-007** — SSH并发控制+信息保护+端口默认行为

### 🟡 中优先（P1 可靠性类 — 1个月内）
11. **R1-001** — sendEvent区分关键事件和普通事件
12. **R4-002+R4-003+R4-004** — Session运行时清理增强
13. **R3-001+R3-002** — Auto-Resume两阶段切换健壮性
14. **R5-004+R5-005+R5-006** — 定时任务DB原子性+错误处理
15. **R6-002+R6-003+R6-004** — TTS运行时并发安全

### 🟢 低优先（P2/P3 — 持续改进）
16. 提取共享函数（密码哈希、Cookie验证、auto-create、ask-question解析）
17. chat.go职责拆分（流执行逻辑移至service层）
18. 前端统一HTTP调用层（api.ts vs 裸fetch）
19. 前端Bridge封装层（类型安全+统一try/catch）
20. proxy.go拆分（721行→4个文件）

---

## 架构级系统性改进建议

### 1. 统一事件可靠传输层
**问题**：4个独立的非阻塞channel发送（session stream、TTS stream、auto-resume forward、SSE relay）都面临事件丢失风险。
**建议**：引入事件优先级机制——`Critical`级事件（done/cancelled/result/resume_split）使用阻塞发送+超时（1s），`Normal`级事件（content/thinking/tool_use_delta）使用非阻塞丢弃。在`sendEvent`/`SendTTSEvent`/`forwardEvent`中统一实现。

### 2. 统一并发安全模型
**问题**：`sync.Map`用于session运行时、TTS运行时、定时任务执行跟踪，但复合操作（check-then-act）缺少原子保证。
**建议**：对需要"检查+操作"原子性的场景，使用`sync.Map.LoadOrStore` CAS模式或引入`sync.Mutex`保护的复合操作方法。为每个运行时管理器提供`RegisterOrGet`原子操作。

### 3. 统一路径安全验证
**问题**：`ValidatePath`使用`filepath.Abs`不解析symlink，且BasePath可被客户端覆盖。
**建议**：`ValidatePath`增加`filepath.EvalSymlinks`解析；所有file_ops端点删除BasePath参数，强制使用project cookie；添加CSP头保护上传文件服务。

### 4. 提取handler→service共享逻辑
**问题**：chat.go 1025行、proxy.go 721行、git.go 516行，handler层承担过多业务逻辑。
**建议**：`executeStreamRun`/`finalizeStreamRun`移至`service/chat.go`；proxy.go拆分为registry/health/detect/tls四个文件；git.go解析器抽离到`internal/git/parser.go`。

### 5. 前端Bridge安全封装
**问题**：Android Native Bridge密码明文暴露、iframe守卫不一致、`window as any`滥用。
**建议**：实现`AndroidNative.autoLogin(url)`接口消除JS层密码暴露；定义`AndroidNativeBridge` TypeScript接口；所有Bridge访问统一经过`useAppMode()`+`window.top`守卫。

### 6. 配置安全基线提升
**问题**：固定盐哈希、无速率限制、Cookie无Secure标志、DB错误系统性忽略。
**建议**：提取`model.HashPassword()`+`model.ValidateSessionCookie()`；添加登录速率限制；条件设置Cookie Secure标志；DB写操作统一检查err。
