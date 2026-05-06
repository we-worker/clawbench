# R10: 认证流程 Review

> 日期: 2026-05-24
> 审查范围: 密码 → 中间件 → Session Cookie → Android自动登录

## 审查范围

### 前端
- `web/src/components/LoginView.vue` (1-155) — 登录页
- `web/src/App.vue` (1-748) — 认证门 + Android 自动登录
- `web/src/composables/useAppMode.ts` (1-39) — App 模式检测

### 后端
- `internal/handler/auth.go` (1-57) — 登录 & 认证检查
- `internal/middleware/auth.go` (1-37) — 认证中间件
- `internal/middleware/logger.go` (1-44) — 请求日志
- `internal/middleware/recover.go` (1-26) — Panic 恢复
- `internal/middleware/request_id.go` (1-32) — 请求 ID
- `cmd/server/main.go` (1-494) — 密码处理
- `internal/model/config.go` (1-102) — 配置结构

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.5/10

**中间件链设计教科书级正确：** `RecoverPanic → WithRequestID → RequestLogger → WithLocalizer → [Auth] → Handler`，panic 最外层、日志在 auth 之前（便于审计登录失败）、localizer 在 auth 之前（认证错误可 i18n）。

**零配置安全默认：** 无密码时自动生成 UUID 密码并持久化到 `.clawbench/auto-password`（0600 权限），避免裸奔部署。

**前端认证门三态清晰：** `isAuthenticated === null`（加载中）→ `false`（登录页）→ `true`（主界面）。

**关键缺陷：**
- 全局单一 `model.SessionToken`，所有用户共享同一个 token，不支持多用户/多会话
- 认证状态全部在内存，重启后 token 不变（哈希确定性），但无法吊销已发出的 cookie
- 无 CSRF 保护，仅依赖 `SameSite: Lax`

### ✨ 代码质量 (30%) — 评分: 7.5/10

**亮点：**
- `LoginView.vue` 简洁（155行），单一职责，错误分类清晰
- `useAppMode.ts` 的 `window !== window.top` 检查防止 iframe 误判
- Cookie 属性设置正确：`HttpOnly: true`, `SameSite: LaxMode`, `Path: "/"`, `MaxAge: 7天`

**关注点：**
- `auth.go:36` 的 `json.NewDecoder(r.Body).Decode(&body)` 忽略了返回错误
- `request_id.go:13` 的 `time.Now().UnixNano()` 作为 request ID 可预测
- `main.go:379` 的自动密码直接 `fmt.Printf` 到 stdout

### 🛡️ 健壮性 (40%) — 评分: 6.0/10

**P0 级问题：**

1. **密码哈希使用 SHA-256 + 硬编码盐**：`sha256(password + "clawbench-salt")` — 静态盐对所有实例相同，SHA-256 不是密码哈希函数（应使用 bcrypt/argon2），同一密码永远产生同一 token

2. **全局共享 session token**：一旦 cookie 泄露，无法单独吊销；知道密码 = 知道所有人的 session token

**P1 级问题：**

3. **无登录速率限制**：`ServeLogin` 无 brute-force 保护，攻击者可无限尝试密码
4. **无 CSRF 保护**：所有 POST 端点仅依赖 cookie + SameSite Lax，无 CSRF token
5. **Android 自动登录密码明文传输**：`getPassword()` 返回明文密码，可通过 JS Bridge 被窃取
6. **自动密码明文输出到 stdout**：进程输出被重定向时可能泄露

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R10-001 | **P0** | 🛡️ 安全 | 密码哈希使用 SHA-256 + 硬编码盐，极易被彩虹表攻破 | `main.go:383` | 使用 bcrypt 或 argon2 |
| R10-002 | **P0** | 🛡️ 安全 | 全局共享 session token，不支持多会话和单独吊销 | `model/config.go` SessionToken | 改为独立随机 token + session store |
| R10-003 | **P1** | 🛡️ 安全 | 无登录速率限制，可暴力破解 | `auth.go:34-55` | 添加 IP 级 rate limiter |
| R10-004 | **P1** | 🛡️ 安全 | 无 CSRF 保护，仅依赖 SameSite Lax | 全局 POST 端点 | 添加 CSRF token 或升级 SameSite 到 Strict |
| R10-005 | **P1** | 🛡️ 安全 | Android 自动登录密码明文传输 | `App.vue:577-578` | 实现 Native 侧自动登录接口 |
| R10-006 | **P1** | 🛡️ 安全 | 自动密码明文输出到 stdout | `main.go:379` | 仅在 `--fg` 模式输出，或脱敏 |
| R10-007 | **P2** | 🛡️ 安全 | Cookie 未设置 Secure flag（TLS 场景） | `auth.go:43` | TLS 启用时自动设置 Secure: true |
| R10-008 | **P2** | 🛡️ 健壮性 | `rand.Read` 返回值未检查 | `defaults.go:67` | 检查 error |
| R10-009 | **P2** | ✨ 质量 | 自动密码写入 slog 未脱敏 | `main.go:373-379` | 只打印前 4 位 + `***` |
| R10-010 | **P2** | 🛡️ 安全 | 字符串比较非 constant-time（时序攻击） | `middleware/auth.go:18` | 风险极低但可使用 `crypto/subtle.ConstantTimeCompare` |
| R10-011 | **P3** | ✨ 质量 | request ID 使用 UnixNano，可预测 | `request_id.go:13` | 改用 UUID v4 |
| R10-012 | **P3** | ✨ 质量 | 登录成功后密码在 JS 内存中持续存在 | `LoginView.vue:47-49` | 功能需求但应文档化风险 |

---

## 改进建议 (Top 3)

1. **密码存储与 Session 机制重构 (R10-001+R10-002)**: 将 `SHA-256(salt+password)` 替换为 `bcrypt` 哈希。Session token 改为 `crypto/rand` 生成的独立随机值（与密码哈希解耦），支持多会话和单会话吊销。这是最直接的安全收益。预期收益：消除密码破解和 token 无法吊销的风险。

2. **添加登录速率限制 + CSRF token (R10-003+R10-004)**: 登录接口加 IP 级 rate limiter（5 次/分钟）。对所有 state-changing POST 端点添加 CSRF token 机制（或升级 `SameSite` 到 `Strict`）。预期收益：防止暴力破解和 CSRF 攻击。

3. **加固 Android 自动登录 (R10-005)**: 实现 `AndroidNative.autoLogin(url)` 接口，原生层直接发起 HTTP 认证请求返回 session cookie，不暴露密码到 JS 层。预期收益：消除 Bridge 密码泄露风险。

---

## 亮点

- **零配置安全默认**：自动生成 UUID 密码 + 0600 权限 + 启动提示
- **中间件链教科书级正确**：RecoverPanic → RequestID → Logger → Localizer → Auth
- **Cookie 属性完善**：HttpOnly + SameSite Lax + Path=/ + MaxAge 7天
- **iframe 误判防护**：useAppMode 的 window.top 检查
- **ParsePresenceMap**：优雅解决 Go bool 零值陷阱
