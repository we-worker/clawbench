# R7: SSH/端口转发 Review

> 日期: 2026-05-10
> 审查范围: SSH Server → direct-tcpip → ProxyRegistry → 健康检查 → 前端浏览

## 审查范围

### SSH层
- `internal/ssh/server.go` (495行) — SSH Server：监听、密码认证(含暴力破解防护)、direct-tcpip channel 处理、host key 生成/持久化、连接统计

### 代理层
- `internal/service/proxy.go` (721行) — ProxyRegistry：端口注册/注销、健康检查(5s轮询)、自动检测(/proc/net/tcp + lsof + netstat)、TLS探测、SQLite持久化
- `internal/model/proxy.go` (16行) — ForwardedPort 模型 + ProxyConfig 配置
- `internal/model/ssh.go` (8行) — SSHConfig 配置

### API层
- `internal/handler/proxy_api.go` (82行) — 端口 CRUD + 自动检测 API
- `internal/handler/ssh_info.go` (74行) — SSH 连接信息 API（含命令生成）

### 前端
- `web/src/components/proxy/ProxyPanel.vue` (786行) — 代理面板：隧道状态、SSH指南、端口列表、添加/检测
- `web/src/components/proxy/ProxyPortItem.vue` (192行) — 单端口项：状态指示、操作按钮
- `web/src/composables/usePortForward.ts` (319行) — 端口转发状态管理：CRUD、隧道健康检查、原生桥接

### 启动
- `cmd/server/main.go` (593行) — 启动编排：ProxyRegistry → SSH Server → 路由注册

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.5/10

**层次清晰，职责划分合理：**
- SSH Server (`ssh.Server`) 负责传输层：监听、认证、channel 接收、双向 relay
- ProxyRegistry (`service.ProxyRegistry`) 负责应用层：端口注册/验证、健康检查、自动检测
- Handler 层薄而干净：`proxy_api.go` 82行、`ssh_info.go` 74行，仅做参数校验和委托
- 前端 composable 模式标准：模块级单例状态 + `usePortForward()` 返回操作函数

**安全层次设计优秀：**
- `authTracker` 实现了完整的暴力破解防护：5次失败 → 指数退避封锁(5min→10min→...→1h max) → 定期清理过期记录
- SSH Server 只允许 `direct-tcpip` channel 类型，拒绝所有其他 channel
- 端口验证：SSH 层用 `IsPortAllowed` 检查范围，HTTP API 层也做相同检查，双重验证

**关注点：**

1. **proxy.go 721行混合四种职责**：端口管理(CRUD+持久化)、健康检查(轮询+dial)、自动检测(3平台+进程解析)、TLS探测。应拆分为独立文件。

2. **SSH Server 无并发控制**：无最大连接数限制、无每连接channel限制。恶意客户端可打开大量SSH连接或channel耗尽资源。

3. **`/api/ssh/info` 无需认证**（`handler.go:210`）：SSH端口、fingerprint、连接统计对未认证用户暴露。注释说"port number and fingerprint are not sensitive"，但结合暴力破解攻击场景，攻击者可据此精确瞄准SSH端口。

4. **前端缺少 `PortForwardBrowser.vue`**：审查范围中列出的文件不存在（仅 `ProxyPanel.vue` 和 `ProxyPortItem.vue`），`ProxyPanel.vue` 承担了所有UI职责（786行），但结构尚可：模板/脚本/样式三段清晰。

5. **模块级全局单例 `service.ProxyService`**：通过全局变量注入，而非依赖注入。虽然项目中普遍采用此模式（`GlobalScheduler` 等），但降低了可测试性。

### ✨ 代码质量 (30%) — 评分: 7.2/10

**亮点：**
- `authTracker` 的 cleanup 定期清理过期记录（10min间隔，30min TTL），防止内存无限增长
- host key 的 `generateAndSaveHostKey` 写入失败时 graceful fallback 到 ephemeral key
- `handleDirectTCPIP` 双向 relay 使用 `WaitGroup` 确保两个方向都完成后才关闭连接
- `CloseWrite()` 正确发送 EOF 信号给对端，`TCPConn.CloseWrite()` 发送 TCP FIN
- `parseProcNetTCPData` 解析 `/proc/net/tcp` 逻辑正确：识别 LISTEN state(0A)、提取端口号(hex→int)、关联 inode
- 前端 `usePortForward.ts` 的隧道健康检查逻辑完善：原生状态优先→服务器stats→端口活跃度，三层降级

**关注点：**

6. **密码比较存在时序侧信道**（`server.go:172`）：使用 `string(pass) == s.password`，攻击者可通过计时逐字节破解密码。应改用 `crypto/subtle.ConstantTimeCompare`。

7. **错误映射不一致**（`proxy_api.go:51`）：`RegisterPort` 返回"not in allowed range"错误被映射为 `model.Forbidden` (403) + "AccessDenied"；而 `UnregisterPort` 返回"not registered"被映射为 `model.NotFound` (404) + "FileNotFoundShort"。语义上合理，但 "FileNotFoundShort" 作为端口未注册的错误key不够精确。

8. **`checkAllPorts` 锁粒度问题**（`proxy.go:268-284`）：先 RLock 复制端口列表，再对每个端口分别 Lock 更新状态。在高频健康检查下，N个端口产生N次 mutex 竞争。虽然正确，但可优化为一次 Lock 批量更新。

9. **`detectTLS` 连接复用问题**（`proxy.go:235-247`）：先用 `net.DialTimeout` 建立 TCP 连接，再用同一个连接做 TLS handshake。但 `conn.SetDeadline` 设置在原始 TCP conn 上，而 TLS handshake 发生在 `tlsConn` 上。实践中因为 `tlsConn` 内部使用同一个底层 conn 所以能工作，但更清晰的做法是在 `tls.Client` 之前设置 deadline。

10. **前端 `ProxyPanel.vue` emit 命名不一致**：`@open` 对应 `openPort`，`@open-external` 对应 `openInExternalBrowser`，`@remove` 对应 `handleRemove`。ProxyPortItem 定义 emit 为 `['open', 'openExternal', 'remove']`，但 ProxyPanel 监听的是 `@open-external`（kebab-case），两者能匹配但不如统一风格。

11. **前端 `usePortForward.ts` 类型安全不足**：`(window as any).AndroidNative?.addForwardedPort(port)` 多处使用 `any`，缺少原生桥接的类型声明。

### 🛡️ 健壮性 (40%) — 评分: 6.0/10

**P0 级问题：**

12. **Backend dial 无超时**（`server.go:384`）：`net.Dial("tcp", targetAddr)` 对不可达后端无限阻塞。如果后端服务挂了但端口仍在 LISTEN 队列中（SYN 已发送但无 ACK），或后端服务卡住不 accept，SSH channel 的 goroutine 将永远阻塞。在大量并发场景下，这会耗尽 goroutine 资源。

13. **HostToConnect 被完全忽略**（`server.go:336-383`）：SSH direct-tcpip channel 数据包含 `HostToConnect` 字段（RFC 4254 Section 7.2），SSH Server 应验证该字段为 `127.0.0.1` 或 `localhost`，否则恶意客户端可通过 SSH 隧道连接服务器上的任意可达主机（SSRF）。当前代码只检查了 `targetPort`，完全没有检查 `d.HostToConnect`。

14. **密码比较时序侧信道**（`server.go:172`）：`string(pass) == s.password` 使用普通字符串比较，攻击者可通过响应时间差异逐字节破解密码。这是 SSH 认证回调中的标准安全缺陷。

**P1 级问题：**

15. **无最大并发连接数限制**（`server.go:221`）：`go s.handleConn(conn, config)` 无条件地为每个新连接启动 goroutine，无上限。恶意客户端可打开大量SSH连接耗尽内存/goroutine。

16. **无每连接 channel 限制**（`server.go:329`）：`go s.handleDirectTCPIP(newChannel)` 无条件地为每个 channel 启动 goroutine，单个SSH连接可打开无限 channel。

17. **io.Copy 无 idle deadline**（`server.go:400-415`）：双向 relay 的 `io.Copy` 无超时。如果一方关闭写但另一方永远不关闭，`io.Copy` 将永远阻塞在读操作上。虽然 `CloseWrite()` 发送了 EOF，但 TCP RST 或半关闭等边界情况可能导致泄漏。

18. **空 AllowedPorts = 允许所有**（`proxy.go:622-624`）：`isPortInRange` 在 `rangeStr` 为空时返回 `true`，意味着 `config.yaml` 中不配置 `allowed_ports` 时默认允许所有端口。这与 SSH 隧道安全模型冲突——用户可能忘记配置端口范围，导致所有端口可通过隧道访问。

19. **SSH 密码与 HTTP 认证共用**（`main.go:511`）：`ssh.NewServer(cfg.SSH, port, cfg.Password, proxyService)` 将HTTP密码直接传入SSH Server。密码以明文存储在 `Server.password` 中，且SSH和HTTP共享同一密码意味着SSH密码泄露等同于HTTP认证泄露。

20. **`authTracker` 指数退避 shift 溢出风险**（`server.go:80-81`）：`1<<uint(infractions-1)` 当 `infractions` 很大时会导致 shift 溢出（Go 中超过63会变成0或负数行为）。虽然有 `maxBlockDur` 兜底，但理论上 `dur` 可能为0或负值，导致 `blockedUntil` 为过去时间，封锁立即失效。

**P2 级问题：**

21. **`registerPort` 错误映射为 Forbidden**（`proxy_api.go:51`）：`RegisterPort` 返回的错误包括"invalid port number"、"not in allowed range"、"already registered"三种情况，全部被映射为 `model.Forbidden` (403)。其中"invalid port number"应为 400 Bad Request，"already registered"应为 409 Conflict。

22. **前端隧道轮询无最大重试**（`usePortForward.ts:212-259`）：`startTunnelPoll` 每5秒轮询一次，但没有最大重试次数或指数退避。如果隧道永久不可达，会无限轮询消耗电池电量和网络流量（尤其在 Android app mode）。

23. **前端 `loadPorts` silent 模式可能丢失错误**（`usePortForward.ts:59-67`）：`loadPorts(true)` 静默模式下 catch 但不报告错误，如果API持续返回错误，用户不会收到任何通知。

24. **`parseLsof` 端口解析脆弱**（`proxy.go:496-511`）：从 `lsof` 输出中提取端口号的逻辑基于 `strings.LastIndex(line, ":")` + 逐字符扫描，对于 IPv6 地址（含多个冒号）可能解析错误。macOS 上 lsof 的 IPv6 输出格式不同。

25. **`parseProcNetTCP` 不解析 IPv6**（`proxy.go:300-305`）：只读 `/proc/net/tcp`（IPv4），不读 `/proc/net/tcp6`。IPv6 LISTEN 端口会被遗漏。

26. **`checkAllPorts` 状态更新不原子**（`proxy.go:268-284`）：在 RLock 和 Lock 之间，端口可能被 UnregisterPort 删除，此时 `r.ports[port]` 的 ok 检查会跳过更新。这不是 bug（ok 检查是正确的），但在极端情况下 health check 结果可能被丢弃。

27. **SSH Server `Close()` 不等待活跃连接**（`server.go:226-232`）：`close(s.done)` + `listener.Close()` 会立即中断 Accept 循环，但已建立的 SSH 连接不会被主动关闭。活跃的 SSH 连接会在客户端断开或 I/O 超时后才清理。

28. **前端 `copySSHCommand` 静默吞掉错误**（`ProxyPanel.vue:243-248`）：`navigator.clipboard.writeText` 的 catch 块为空，如果浏览器不支持或权限被拒绝，用户不会收到任何反馈。

29. **`detectTLS` InsecureSkipVerify**（`proxy.go:243`）：`tls.Config{InsecureSkipVerify: true}` 是为了探测目的，这是合理的，但应添加注释说明这是有意为之。

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R7-001 | **P0** | 🛡️ 安全 | HostToConnect 未验证，允许通过SSH隧道SSRF访问任意主机 | `server.go:336-383` | 验证 `d.HostToConnect` 为 `127.0.0.1`/`localhost`/`::1`，否则 Reject |
| R7-002 | **P0** | 🛡️ 健壮性 | Backend dial 无超时，不可达后端导致goroutine无限阻塞 | `server.go:384` | 改用 `net.DialTimeout("tcp", targetAddr, 10*time.Second)` |
| R7-003 | **P0** | 🛡️ 安全 | 密码比较使用 `==`，存在时序侧信道攻击 | `server.go:172` | 改用 `subtle.ConstantTimeCompare([]byte(pass), []byte(s.password))` |
| R7-004 | **P1** | 🛡️ 健壮性 | 无最大并发SSH连接数限制 | `server.go:221` | 添加 `maxConnections` 配置（默认20），用 `atomic.Int32` 计数 |
| R7-005 | **P1** | 🛡️ 健壮性 | 无每连接channel限制 | `server.go:329` | 添加 `maxChannelsPerConn`（默认10），在 channel 循环中计数 |
| R7-006 | **P1** | 🛡️ 安全 | `/api/ssh/info` 无需认证，暴露SSH端口和连接统计 | `handler.go:210` | 加 `middleware.Auth` 保护 |
| R7-007 | **P1** | 🛡️ 安全 | 空 AllowedPorts = 允许所有端口 | `proxy.go:622-624` | 空 list 应拒绝所有，或在文档中明确说明默认行为 |
| R7-008 | **P1** | 🛡️ 安全 | SSH密码与HTTP认证共用，明文存储 | `main.go:511`, `server.go:147` | SSH 密码独立配置，或支持公钥认证 |
| R7-009 | **P1** | 🛡️ 健壮性 | io.Copy 无 idle deadline，单个channel可无限占用 | `server.go:400-415` | 添加连接空闲超时（如 30min），定期 SetDeadline |
| R7-010 | **P2** | 🛡️ 健壮性 | authTracker 指数退避 shift 溢出风险 | `server.go:80-81` | 添加 `infractions` 上界检查，或用 `min()` 限制 shift 位数 |
| R7-011 | **P2** | 🏗️ 架构 | proxy.go 721行混合四种职责 | `service/proxy.go` | 拆分为 proxy_registry.go / proxy_health.go / proxy_detect.go |
| R7-012 | **P2** | ✨ 质量 | registerPort 三种错误全映射为 403 Forbidden | `proxy_api.go:50-51` | 区分 400(无效端口) / 403(不在允许范围) / 409(已注册) |
| R7-013 | **P2** | 🛡️ 健壮性 | 前端隧道轮询无最大重试和退避 | `usePortForward.ts:212-259` | 添加最大重试次数（如20次）和指数退避 |
| R7-014 | **P2** | 🛡️ 健壮性 | parseProcNetTCP 不解析 IPv6 | `proxy.go:300-305` | 同时读 `/proc/net/tcp6` |
| R7-015 | **P2** | ✨ 质量 | detectTLS InsecureSkipVerify 未注释 | `proxy.go:243` | 添加注释说明这是探测用途，有意跳过验证 |
| R7-016 | **P2** | 🛡️ 健壮性 | SSH Server Close 不等待活跃连接 | `server.go:226-232` | 添加带超时的 graceful shutdown：通知所有活跃连接关闭 |
| R7-017 | **P2** | ✨ 质量 | 前端原生桥接使用 `any` 类型，无类型安全 | `usePortForward.ts:73,82,97,200,274,289` | 创建 `AndroidNativeBridge` 接口声明 |
| R7-018 | **P3** | ✨ 质量 | 错误key "FileNotFoundShort" 用于端口未注册 | `proxy_api.go:68` | 使用更精确的错误key如 "PortNotRegistered" |
| R7-019 | **P3** | ✨ 质量 | copySSHCommand 静默吞掉clipboard错误 | `ProxyPanel.vue:247` | 添加 toast 提示 |
| R7-020 | **P3** | 🏗️ 架构 | 模块级全局 ProxyService 单例 | `service/proxy.go:34` | 项目统一风格，可接受；如需可改为依赖注入 |

---

## 改进建议 (Top 3)

1. **修复 SSH SSRF 漏洞 + 后端 dial 超时 + 时序安全密码比较 (R7-001 + R7-002 + R7-003)**: 这三个 P0 问题形成安全防线的关键缺口。`handleDirectTCPIP` 应验证 `d.HostToConnect` 为 `127.0.0.1`/`localhost`/`::1`（否则 Reject），backend dial 改用 `net.DialTimeout` 设置 10s 超时，密码比较改用 `subtle.ConstantTimeCompare`。预期收益：消除 SSRF 攻击面、goroutine 资源耗尽风险和时序侧信道漏洞。

2. **添加 SSH 并发控制 (R7-004 + R7-005)**: SSH Server 添加 `maxConnections`（默认20）和 `maxChannelsPerConn`（默认10）配置。使用 `atomic.Int32` 跟踪当前连接数，超过限制拒绝新连接；在 channel 循环中计数，超过限制拒绝新 channel。预期收益：防止单个恶意客户端耗尽服务器资源。

3. **保护 `/api/ssh/info` 端点 + 审视空 AllowedPorts 默认行为 (R7-006 + R7-007)**: SSH info 端点应加 `middleware.Auth` 保护；`isPortInRange` 空 string 的默认行为应从"允许所有"改为使用合理的默认范围（如 1024-65535），或在配置文档中明确标注风险。预期收益：减少信息泄露面，避免因配置遗漏导致过度暴露。

---

## 亮点

- **authTracker 指数退避暴力破解防护**：5次失败→指数退避封锁（5min→10min→...→1h max），定期 cleanup 过期记录（10min间隔，30min TTL），设计完整且高效
- **Host key 自动生成/持久化 fallback 链**：优先从文件加载→文件不存在则生成并保存→保存失败则 fallback 到 ephemeral key，三层容错
- **双向 relay WaitGroup + CloseWrite**：确保两个方向都完成后才关闭连接，`CloseWrite()` 正确发送 EOF 给 SSH channel，`TCPConn.CloseWrite()` 发送 TCP FIN
- **三层端口发现机制**：手动注册 + 自动检测（Linux /proc/net/tcp + macOS lsof + Windows netstat）+ TLS 探测，覆盖三个主流平台
- **前端隧道健康检查三层降级**：原生 SSH tunnel 状态优先→服务器 connectionStats→端口活跃度，robust 地处理各种降级场景
- **SQLite 持久化端口配置**：重启后自动恢复已注册端口，健康检查立即更新状态，用户体验连贯
- **SSH Server 只允许 direct-tcpip channel**：拒绝所有其他 channel 类型，限制攻击面
