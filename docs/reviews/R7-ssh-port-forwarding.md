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

### 🏗️ 架构设计 (30%) — 评分: 8.0/10

**SSH Server 设计精良：**
- `Server` 结构体职责单一：监听、认证、处理 direct-tcpip channel
- `authTracker` 实现了完整的暴力破解防护：5次失败 → 指数退避封锁（5min → 10min → ... → 1h max）
- 支持 ECDSA host key 自动生成/持久化，ephermeral key fallback

**ProxyRegistry 设计合理：**
- 健康检查（5s 间隔）、自动检测（/proc/net/tcp + lsof + netstat）、TLS 探测
- 端口验证通过 `IsPortAllowed` 检查 `allowed_ports` 配置
- 前端浏览和 SSH 隧道共用同一个端口注册表

**关注点：**
- SSH Server 无最大并发连接数限制，恶意客户端可打开大量连接耗尽资源
- `handleDirectTCPIP` 对每个 channel 启动 2 个 goroutine（双向 relay），大量并发 channel 可能产生大量 goroutine
- `/api/ssh/info` 无需认证暴露 SSH 连接信息

### ✨ 代码质量 (30%) — 评分: 7.5/10

**亮点：**
- `authTracker` 的 `cleanup` 定期清理过期记录，防止内存泄漏
- host key 的 `generateAndSaveHostKey` 写入失败时 graceful fallback 到 ephemeral key
- `handleDirectTCPIP` 的双向 relay 使用 `WaitGroup` 确保两个方向都完成后才关闭

**关注点：**
- `proxy.go` 720 行，混合了端口管理、健康检查、自动检测、TLS 探测，职责过重
- SSH Server 的 `connCount`/`activeChannels` 使用 `sync.Mutex` 保护，但 `ConnectionStats()` 返回时已释放锁，stats 可能立即过时
- 前端 `ProxyPanel.vue` 784 行，混合了 SSH 配置、端口浏览、手动添加端口

### 🛡️ 健壮性 (40%) — 评分: 6.5/10

**P0 级问题：**

1. **`/api/ssh/info` 无认证**：暴露 SSH 端口号、host key fingerprint、连接统计给未认证用户。攻击者可据此进行 SSH 暴力破解

2. **无最大并发连接数限制**：恶意客户端可打开大量 SSH 连接，每个连接消耗 goroutine 和内存

**P1 级问题：**

3. **`HostToConnect` 只验证端口不验证主机**：`handleDirectTCPIP` 只检查 `PortToConnect` 是否在 `allowed_ports` 范围内，但 `HostToConnect` 被忽略，直接连接 `127.0.0.1:port`。虽然 RFC 4254 规定 direct-tcpip 的目标主机，但当前实现硬编码 `127.0.0.1`，这实际上是安全的（不允许连接外部主机）

4. **SSH 密码明文存储**：`Server.password` 以明文存储在内存中，且与 HTTP 认证共用同一密码

5. **健康检查的 goroutine 泄漏**：`proxy.go` 的 `StartHealthChecks` 启动了一个长期运行的 goroutine，如果 `Stop()` 未被调用，goroutine 会泄漏

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R7-001 | **P0** | 🛡️ 安全 | `/api/ssh/info` 无需认证，暴露 SSH 端口和指纹 | `handler.go:207` + `ssh_info.go` | 加 `middleware.Auth` 保护（与 R1-013 同源） |
| R7-002 | **P0** | 🛡️ 健壮性 | SSH Server 无最大并发连接数限制 | `server.go:209-222` | 添加 `maxConnections` 配置和原子计数器 |
| R7-003 | **P1** | 🛡️ 安全 | SSH 密码与 HTTP 认证共用，明文存储 | `server.go:147` | SSH 密码应独立于 HTTP 密码，或使用密钥认证 |
| R7-004 | **P1** | 🛡️ 泄漏 | 健康检查 goroutine 可能泄漏 | `proxy.go` StartHealthChecks | 确保在 Close/Stop 中通知退出 |
| R7-005 | **P1** | 🛡️ 健壮性 | `handleDirectTCPIP` 的 backend dial 无超时 | `server.go:384` | 添加 10s 连接超时 |
| R7-006 | **P1** | 🛡️ 健壮性 | `io.Copy` 无流量限制，单个 channel 可无限占用带宽 | `server.go:400-415` | 考虑添加带宽限制或连接超时 |
| R7-007 | **P2** | 🏗️ 架构 | `proxy.go` 720 行，混合多种职责 | `service/proxy.go` | 拆分：端口管理、健康检查、自动检测各一文件 |
| R7-008 | **P2** | ✨ 质量 | `ConnectionStats()` 返回时锁已释放，stats 可能过时 | `server.go:275-288` | 可接受（监控场景），但应注释说明 |
| R7-009 | **P2** | ✨ 质量 | 前端 ProxyPanel.vue 784 行职责过重 | `ProxyPanel.vue` | 拆分 SSH 配置和端口浏览 |
| R7-010 | **P2** | 🛡️ 安全 | SSH 仅支持密码认证，不支持公钥认证 | `server.go:164-180` | 添加 PublicKeyCallback 支持 |
| R7-011 | **P3** | ✨ 质量 | `Port()` 使用 `fmt.Sscanf` 解析端口号 | `server.go:260-264` | 使用 `strconv.Atoi` 更明确 |
| R7-012 | **P3** | ✨ 质量 | host key 文件权限 0600 仅在 Linux 有效 | `server.go:465` | Windows 上需额外 ACL 设置 |

---

## 改进建议 (Top 3)

1. **保护 `/api/ssh/info` + 限制并发连接 (R7-001+R7-002)**: SSH 信息端点必须加认证保护。SSH Server 应添加 `maxConnections` 配置（默认 10），使用 `atomic.Int32` 计数当前连接数，超过限制拒绝新连接。预期收益：消除信息泄露和资源耗尽风险。

2. **SSH 密码独立化 + 支持公钥认证 (R7-003+R7-010)**: SSH 密码应独立于 HTTP 密码，支持在配置中分别设置。添加 `PublicKeyCallback` 支持公钥认证，提升安全性。预期收益：消除 SSH 密码泄露对 HTTP 认证的影响。

3. **拆分 `proxy.go` (R7-007)**: 720 行的 `proxy.go` 混合了端口管理、健康检查、自动检测、TLS 探测四种职责。建议拆分为 `proxy_registry.go`（端口 CRUD）、`proxy_health.go`（健康检查）、`proxy_detect.go`（自动检测+TLS）。预期收益：每个文件 < 250 行，可独立测试和维护。

---

## 亮点

- **authTracker 暴力破解防护**：5次失败 → 指数退避封锁，定期 cleanup 过期记录，设计完善
- **Host key 自动生成/持久化**：优先从文件加载，文件不存在则生成并保存，保存失败则 fallback 到 ephemeral key
- **双向 relay WaitGroup**：确保两个方向都完成后才关闭连接
- **allowed_ports 配置**：SSH 隧道和 HTTP 代理共用同一端口白名单
- **健康检查 + 自动检测 + TLS 探测**：三层端口发现机制，覆盖手动注册、自动发现、协议识别
