# R7: SSH/端口转发 Review

> 日期: 2026-05-24
> 审查范围: SSH Server → direct-tcpip → ProxyRegistry → 健康检查 → 前端浏览

## 审查范围

### 后端
- `internal/ssh/server.go` (1-495) — SSH Server
- `internal/service/proxy.go` (1-720) — ProxyRegistry
- `internal/model/proxy.go` (1-16) — 代理模型
- `internal/model/ssh.go` (1-8) — SSH模型
- `internal/handler/proxy_api.go` (1-82) — 代理API
- `internal/handler/ssh_info.go` (1-74) — SSH信息API
- `cmd/server/main.go` (1-494) — 启动编排

### 前端
- `web/src/components/proxy/ProxyPanel.vue` (1-784) — 代理面板
- `web/src/components/proxy/PortForwardBrowser.vue` (1-276) — 端口浏览
- `web/src/components/proxy/ProxyPortItem.vue` (1-183) — 端口项
- `web/src/composables/usePortForward.ts` (1-307) — 端口转发状态

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.8/10

**SSH Server 设计精良：**
- `Server` 结构体职责单一：监听、认证、处理 direct-tcpip channel
- `authTracker` 实现了完整的暴力破解防护：5次失败 → 指数退避封锁（5min → 10min → ... → 1h max）
- 支持 ECDSA host key 自动生成/持久化，ephemeral key fallback

**ProxyRegistry 设计合理：**
- 健康检查（5s 间隔）、自动检测（/proc/net/tcp + lsof + netstat）、TLS 探测
- 端口验证通过 `IsPortAllowed` 检查 `allowed_ports` 配置
- 前端浏览和 SSH 隧道共用同一个端口注册表

**关注点：**
- SSH Server 无最大并发连接数限制，恶意客户端可打开大量连接耗尽资源
- `handleDirectTCPIP` 对每个 channel 启动 2 个 goroutine（双向 relay），大量并发 channel 可能产生大量 goroutine
- `/api/ssh/info` 无需认证暴露 SSH 连接信息
- `proxy.go` 720 行混合了端口管理、健康检查、自动检测、TLS 探测，职责过重

### ✨ 代码质量 (30%) — 评分: 7.3/10

**亮点：**
- `authTracker` 的 `cleanup` 定期清理过期记录，防止内存泄漏
- host key 的 `generateAndSaveHostKey` 写入失败时 graceful fallback 到 ephemeral key
- `handleDirectTCPIP` 的双向 relay 使用 `WaitGroup` 确保两个方向都完成后才关闭

**关注点：**
- `proxy.go` 720 行，混合了端口管理、健康检查、自动检测、TLS 探测，职责过重
- SSH Server 的 `connCount`/`activeChannels` 使用 `sync.Mutex` 保护，但 `ConnectionStats()` 返回时已释放锁，stats 可能立即过时
- 前端 `ProxyPanel.vue` 784 行，混合了 SSH 配置、端口浏览、手动添加端口

### 🛡️ 健壮性 (40%) — 评分: 6.2/10

**P0 级问题：**

1. **`/api/ssh/info` 无认证**：`handler.go:210` 暴露 SSH 端口、fingerprint、连接统计给未认证用户，攻击者可据此进行 SSH 暴力破解

2. **Backend dial 无超时**：`server.go:384` `net.Dial` 对不可达后端无限阻塞，耗尽 goroutine

3. **时序漏洞密码比较**：`server.go:172` 使用 `==` 而非 `subtle.ConstantTimeCompare`，攻击者可通过计时侧信道逐字节破解密码

**P1 级问题：**

4. **无最大并发连接数限制**：`server.go:221` 恶意客户端可打开大量 SSH 连接耗尽资源

5. **无每连接 channel 限制**：`server.go:329` 单个连接可打开无限 channel

6. **HostToConnect 被静默忽略**：`server.go:352-356` 应拒绝非 localhost 目标

7. **子进程调用使用裸命令名**：`proxy.go:476,525,589` 的 lsof/netstat/tasklist 存在 PATH 注入风险

8. **空 AllowedPorts = 允许所有**：`proxy.go:622-624` 缺失配置时静默开放所有端口

9. **SSH 密码与 HTTP 认证共用**：`server.go:147` 明文存储在内存中

10. **健康检查 goroutine 可能泄漏**：`proxy.go` 的 `StartHealthChecks` 在 `Stop()` 未调用时泄漏

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R7-001 | **P0** | 🛡️ 安全 | `/api/ssh/info` 无需认证，暴露 SSH 端口和指纹 | `handler.go:210` | 加 `middleware.Auth` 保护 |
| R7-002 | **P0** | 🛡️ 健壮性 | Backend dial 无超时，对不可达后端无限阻塞 | `server.go:384` | 使用 `net.DialTimeout`，10s 超时 |
| R7-003 | **P0** | 🛡️ 安全 | 密码比较使用 == 存在时序侧信道 | `server.go:172` | 改用 `subtle.ConstantTimeCompare` |
| R7-004 | **P1** | 🛡️ 健壮性 | 无最大并发连接数限制 | `server.go:221` | 添加 `maxConnections` 配置和原子计数器 |
| R7-005 | **P1** | 🛡️ 健壮性 | 无每连接 channel 限制 | `server.go:329` | 添加 `maxChannelsPerConn` 限制 |
| R7-006 | **P1** | 🛡️ 安全 | HostToConnect 被静默忽略，应拒绝非 localhost | `server.go:352-356` | 显式验证并拒绝非 127.0.0.1/::1 |
| R7-007 | **P1** | 🛡️ 安全 | 子进程调用使用裸命令名（lsof, netstat），PATH 注入风险 | `proxy.go:476,525,589` | 使用绝对路径 |
| R7-008 | **P1** | 🛡️ 安全 | 空 AllowedPorts = 允许所有端口 | `proxy.go:622-624` | 空 list 应拒绝所有而非允许所有 |
| R7-009 | **P1** | 🛡️ 安全 | SSH 密码与 HTTP 认证共用，明文存储 | `server.go:147` | SSH 密码独立或支持公钥认证 |
| R7-010 | **P1** | 🛡️ 泄漏 | 健康检查 goroutine 可能泄漏 | `proxy.go` StartHealthChecks | 确保在 Close/Stop 中通知退出 |
| R7-011 | **P2** | 🛡️ 健壮性 | io.Copy 无 deadline，单个 channel 可无限占用 | `server.go:397-417` | 添加连接超时或 idle deadline |
| R7-012 | **P2** | 🛡️ 健壮性 | 极端失败计数下 shift overflow | `server.go:80-81` | 添加上界检查 |
| R7-013 | **P2** | 🏗️ 架构 | proxy.go 720 行混合多种职责 | `service/proxy.go` | 拆分：端口管理、健康检查、自动检测各一文件 |
| R7-014 | **P2** | ✨ 质量 | ConnectionStats() 返回时锁已释放，stats 可能过时 | `server.go:275-288` | 可接受（监控场景），但应注释说明 |
| R7-015 | **P2** | 🛡️ 安全 | SSH 仅支持密码认证，不支持公钥认证 | `server.go:164-180` | 添加 PublicKeyCallback 支持 |

---

## 改进建议 (Top 3)

1. **保护 `/api/ssh/info` + 限制并发连接 + dial 超时 (R7-001+R7-004+R7-002)**: SSH 信息端点必须加认证保护。SSH Server 添加 `maxConnections` 配置（默认 10），使用 `atomic.Int32` 计数当前连接数，超过限制拒绝新连接。Backend dial 使用 `net.DialTimeout` 设置 10s 超时。预期收益：消除信息泄露、资源耗尽和 goroutine 阻塞风险。

2. **修复时序漏洞密码比较 (R7-003)**: `server.go:172` 的密码比较从 `==` 改为 `subtle.ConstantTimeCompare`，消除计时侧信道攻击。这是一行代码的修复，安全收益巨大。

3. **拆分 `proxy.go` (R7-013)**: 720 行的 `proxy.go` 混合了端口管理、健康检查、自动检测、TLS 探测四种职责。建议拆分为 `proxy_registry.go`（端口 CRUD）、`proxy_health.go`（健康检查）、`proxy_detect.go`（自动检测+TLS）。预期收益：每个文件 < 250 行，可独立测试和维护。

---

## 亮点

- **authTracker 指数退避暴力破解防护**：5次失败 → 指数退避封锁，定期 cleanup 过期记录，设计完善
- **Host key 自动生成/持久化**：优先从文件加载，文件不存在则生成并保存，保存失败则 fallback 到 ephemeral key
- **双向 relay WaitGroup**：确保两个方向都完成后才关闭连接
- **三层端口发现机制**：手动注册 + 自动检测（/proc/net/tcp + lsof + netstat）+ TLS 探测
