# R10: 认证流程 Review

> 日期: 2026-05-09
> 审查范围: 登录 → 密码哈希 → Cookie → 中间件鉴权 → 本地绕过

## 审查范围

### 后端
- `internal/middleware/auth.go` (1-50) — 认证中间件
- `internal/middleware/request_id.go` (1-20) — 请求 ID
- `internal/middleware/recover.go` (1-30) — Panic 恢复
- `internal/middleware/logger.go` (1-70) — 请求日志
- `internal/handler/auth.go` (1-60) — 登录 Handler
- `internal/model/config.go` (1-105) — 配置模型
- `cmd/server/main.go` (1-494) — 启动编排

### 前端
- `web/src/views/LoginView.vue` (1-150) — 登录界面
- `web/src/App.vue` (1-700) — 全局认证编排

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.5/10

**中间件链设计教科书级正确：**
- `RecoverPanic → RequestID → Logger → Localizer → Auth → Handler`，顺序严格：恢复在最外层保证不漏 panic，RequestID 在 Logger 前保证日志可追踪，Auth 在 Handler 前保证所有业务逻辑受保护
- 三态认证门控设计精巧：`middleware.Auth` 返回三种状态——`null`（未设置密码，放行）、`true`（Cookie 有效，放行）、`false`（Cookie 无效，401），覆盖了零配置和有密码两种部署模式

**零配置安全默认值出色：**
- 密码为空时自动生成 UUID → 持久化到 `.clawbench/auto-password`（0600 权限）
- Cookie 属性完整：`HttpOnly` + `SameSite=Lax` + `Path=/api` + `MaxAge`
- `ParsePresenceMap` 解决 Go bool 零值陷阱（`proxy.enabled` 和 `ssh.enabled` 默认应为 `true`，但 Go 零值为 `false`）

**关键缺陷：**
- **全局单 Token**：`model.SessionToken` 是包级变量，所有客户端共享同一 token，不支持多会话和单独吊销
- **无 CSRF 保护**：全局 POST 端点（`/api/ai/chat`、`/api/tasks`）无 CSRF token 或 `SameSite=Strict`，仅依赖 `SameSite=Lax` 限制了部分跨站 POST

### ✨ 代码质量 (30%) — 评分: 7.3/10

**亮点：**
- `LoginView.vue` 简洁（150行），移动端适配良好
- Cookie 属性设置正确完整（HttpOnly + Lax + Path + MaxAge）
- `ParsePresenceMap` 使用 `encoding/json.Decoder` 精确检测字段是否存在，避免零值歧义

**关注点：**
- `auth.go:55` JSON decode 错误被忽略（`json.NewDecoder(r.Body).Decode(&req)` 返回值未检查），畸形请求体时 `req.Password` 为空字符串，可能导致意外行为
- `request_id.go:13` 使用 `time.Now().UnixNano()` 生成请求 ID，时间戳可预测，不利于安全追踪
- `LoginView.vue:74-76` 直接访问 `window.AndroidNative` 而非通过统一封装，与 `useAppMode` 的桥接模式不一致

### 🛡️ 健壮性 (40%) — 评分: 5.5/10

**P0 级问题：**

1. **SHA-256 + 硬编码盐值密码哈希**：`auth.go:37` 和 `main.go:398` 使用 `sha256.Sum256([]byte(password + "clawbench-salt"))` 做密码哈希。SHA-256 是快速哈希，硬编码盐值等同于无盐，GPU 暴力破解成本极低
2. **时序攻击**：`auth.go:39` 和 `middleware/auth.go:38` 使用 `==` 比较 token，非恒定时间比较，攻击者可通过响应时间差异逐字节推断 token
3. **自动密码输出到 stdout**：`main.go:394` `fmt.Printf("Auto-generated password: %s\n", password)` 将密码打印到标准输出，可被子进程读取（`/proc/self/fd/1`）或 journalctl 记录
4. **Android 自动登录明文密码**：`App.vue:579-587` 和 `LoginView.vue:74-76` 通过 `AndroidNative.getPassword()` 获取明文密码并在网络请求中传输

**P1 级问题：**

5. **无登录速率限制**：`auth.go:34-55` 无任何速率限制，暴力破解成本仅受网络延迟限制
6. **无 CSRF 保护**：全局 POST 端点仅依赖 `SameSite=Lax`，不阻止同站 GET 请求发起的攻击
7. **Cookie 缺少 Secure 标志**：`auth.go:40-47` 设置 Cookie 时未指定 `Secure=true`，HTTP 连接下 Cookie 可被中间人窃取
8. **Localhost 认证绕过不感知代理**：`middleware/auth.go:13-19` 使用 `r.RemoteAddr` 判断 localhost，但反向代理场景下 `RemoteAddr` 是代理地址，可能导致非 localhost 来源绕过认证
9. **请求 ID 可预测**：`request_id.go:13` 使用纳秒时间戳，攻击者可推断其他请求的 ID
10. **全局共享 Session Token**：`model/config.go:121` 所有客户端共享同一 token，无法单会话吊销，一个泄露全部失效

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R10-001 | **P0** | 🛡️ 安全 | SHA-256 + 硬编码盐值密码哈希，GPU 暴力破解成本极低 | `auth.go:37`, `main.go:398` | 替换为 `bcrypt.GenerateFromPassword`，cost ≥ 12 |
| R10-002 | **P0** | 🛡️ 安全 | 时序攻击：token 比较使用 `==`，非恒定时间 | `auth.go:39`, `middleware/auth.go:38` | 使用 `subtle.ConstantTimeCompare` |
| R10-003 | **P0** | 🛡️ 安全 | 自动密码打印到 stdout，可被子进程/journal 捕获 | `main.go:394` | 改为写入 stderr 或仅写入 `.clawbench/auto-password` 文件 |
| R10-004 | **P0** | 🛡️ 安全 | Android 自动登录发送明文密码，可被同源 JS 窃取 | `App.vue:579-587`, `LoginView.vue:74-76` | 实现 `AndroidNative.autoLogin(url)` 接口，消除密码传递 |
| R10-005 | **P1** | 🛡️ 安全 | 无登录速率限制，暴力破解成本极低 | `auth.go:34-55` | 添加 IP 级 rate limiter（如 5 次/分钟） |
| R10-006 | **P1** | 🛡️ 安全 | 无 CSRF 保护，仅依赖 `SameSite=Lax` | 全局 POST 端点 | 添加 CSRF token 或升级 `SameSite=Strict` |
| R10-007 | **P1** | 🛡️ 安全 | Cookie 缺少 Secure 标志，HTTP 下可被窃取 | `auth.go:40-47` | 在 TLS 模式下设置 `Secure=true` |
| R10-008 | **P1** | 🛡️ 安全 | Localhost 认证绕过不感知反向代理 | `middleware/auth.go:13-19` | 使用 `X-Forwarded-For` 或 `X-Real-IP` header |
| R10-009 | **P1** | 🛡️ 安全 | 请求 ID 使用纳秒时间戳，可预测 | `request_id.go:13` | 使用 `crypto/rand` 生成随机 ID |
| R10-010 | **P1** | 🛡️ 安全 | 全局共享 Session Token，不支持多会话和单独吊销 | `model/config.go:121` | 改为 per-session token + token 存储 |
| R10-011 | **P2** | 🛡️ 安全 | `.clawbench/` 目录以 0755 权限创建 | `defaults.go:70` | 改为 0750 或 0700 |
| R10-012 | **P2** | 🛡️ 安全 | 明文密码在内存中存活进程整个生命周期 | `main.go`, `config.go` | 使用后尽快清零（`memset`/`runtime.KeepAlive`） |
| R10-013 | **P2** | 🛡️ 安全 | 日志中的 RemoteAddr 不感知代理 | `logger.go:55` | 使用 `X-Real-IP` 或 `X-Forwarded-For` |
| R10-014 | **P2** | 🏗️ 架构 | Auth 中间件仅包装 `HandlerFunc`，不支持 `http.Handler` | `middleware/auth.go:24` | 提供两个签名或使用适配器 |
| R10-015 | **P3** | ✨ 质量 | Panic 恢复硬编码英文错误信息 | `recover.go:21` | 使用 i18n 或从配置读取 |
| R10-016 | **P3** | ✨ 质量 | 登录响应缺少 Content-Type header | `auth.go:49` | 显式设置 `Content-Type: application/json` |

---

## 改进建议 (Top 3)

1. **替换 SHA-256 + 硬编码盐为 bcrypt (R10-001)**: 当前密码哈希使用 `sha256.Sum256([]byte(password + "clawbench-salt"))`，SHA-256 是快速哈希 + 硬编码盐值等同于无盐，现代 GPU 可达数十亿次/秒。建议替换为 `bcrypt.GenerateFromPassword([]byte(password), 12)`，bcrypt 自带盐值 + 可调 cost，暴力破解成本提升 5-6 个数量级。需注意 bcrypt 迁移策略：兼容期同时支持旧 SHA-256 验证，验证成功后自动 rehash 为 bcrypt。预期收益：消除密码破解风险，这是最高安全影响的修复。

2. **使用 subtle.ConstantTimeCompare 进行所有 Token 比较 (R10-002)**: 当前 `auth.go:39` 和 `middleware/auth.go:38` 使用 `==` 比较 token，非恒定时间比较允许时序攻击——攻击者通过响应时间差异逐字节推断 token。建议所有认证相关的字符串比较使用 `subtle.ConstantTimeCompare`，将 token 统一为固定长度（如 hex 编码）。预期收益：消除时序攻击向量。

3. **添加登录速率限制 + CSRF 保护 (R10-005+R10-006)**: 当前无登录速率限制，暴力破解成本仅受网络延迟限制；全局 POST 端点无 CSRF 保护。建议：(1) 添加 IP 级 rate limiter（5 次/分钟，指数退避封锁）；(2) 添加 CSRF double-submit cookie 或升级 `SameSite=Strict`。预期收益：防止暴力破解和跨站请求伪造。

---

## 亮点

- **零配置安全默认值**：自动 UUID 密码 + 0600 文件权限，无需用户干预即可获得基本安全
- **中间件链教科书级正确**：`RecoverPanic → RequestID → Logger → Localizer → Auth → Handler` 顺序严格
- **Cookie 属性完整**：`HttpOnly` + `SameSite=Lax` + `Path=/api` + `MaxAge`，覆盖主流攻击向量
- **ParsePresenceMap**：教科书级解决 Go bool 零值陷阱，`proxy.enabled` 和 `ssh.enabled` 正确默认为 `true`
- **iframe 误判防护**：`window === window.top` 检测确保 Bridge 仅在顶层窗口可用
