# R12: Android Bridge Review

> 日期: 2026-05-09
> 审查范围: WebView检测 → Bridge接口 → 密码传递 → 端口转发 → 隧道健康检查

## 审查范围

### 前端
- `web/src/App.vue` (1-700) — Bridge 编排、密码传递
- `web/src/views/LoginView.vue` (1-150) — 自动登录、Bridge 检测
- `web/src/composables/useAppMode.ts` (1-50) — WebView 检测、App 模式
- `web/src/composables/usePortForward.ts` (1-307) — 端口转发、Bridge 调用、隧道健康检查
- `web/src/components/proxy/ProxyPanel.vue` (1-784) — 代理面板
- `web/src/components/proxy/PortForwardBrowser.vue` (1-276) — 端口浏览

### 后端（间接关联）
- `internal/ssh/server.go` — SSH 隧道服务
- `internal/service/proxy.go` — ProxyRegistry
- `internal/handler/ssh_info.go` — SSH 信息 API

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.5/10

**iframe 隔离设计是安全基石：**
- `window === window.top` 检测确保 Bridge 接口仅在顶层窗口可用
- `data-app-mode` CSS 属性实现 WebView 专属样式，与 `@media (hover: hover)` 配合区分触摸/鼠标设备
- App/Web 双模式 UI 通过 `v-if="isAppMode"` 清晰隔离，条件边界明确

**三层隧道健康降级：**
- Native 桥接 > Server 端健康检查 > 端口活跃检测
- `checkTunnelHealth` 逐步降级：先检查 Native `isTunnelHealthy()` → 再请求 Server `/api/proxy/...` → 最后探测端口是否活跃
- 每层独立恢复，不互相阻塞

**关注点：**
- Bridge 调用散布在 `App.vue`、`LoginView.vue`、`usePortForward.ts` 中，无统一封装
- `window as any` 滥用（15+ 次），无类型安全接口定义
- `usePortForward.ts:282,295` 硬编码 `localhost`，Web 模式远程访问时断连

### ✨ 代码质量 (30%) — 评分: 6.8/10

**亮点：**
- 隧道健康检查逻辑清晰：三层降级 + 轮询 + 可视化状态
- App/Web 双模式 UI 设计整洁，`v-if` 边界清晰

**关注点：**
- `checkTunnelHealth` 80 行函数过长，混合了 Native 检测、HTTP 请求、端口探测三种逻辑
- `ProxyPanel.vue` 63% 是 CSS（~490 行），组件样式与逻辑比例失调
- Bridge 调用无 try/catch 包裹，WebView 未加载时直接崩溃
- `(window as any).AndroidNative` vs `window.AndroidNative` 两种访问模式不一致

### 🛡️ 健壮性 (40%) — 评分: 5.5/10

**P0 级问题：**

1. **`getPassword()` 无访问控制**：`App.vue:577` Bridge 被注入到所有 frame，任何同源 iframe 都可调用 `AndroidNative.getPassword()` 窃取密码。虽然 `window === window.top` 检查限制了部分场景，但 `LoginView.vue:74` 直接访问 `window.AndroidNative` 绕过了此检查
2. **Bridge 密码明文传输**：`App.vue:579-586` 通过 `AndroidNative.getPassword()` 获取明文密码，再通过 HTTP 请求发送。在非 TLS 环境下密码可被中间人截获
3. **LoginView 绕过 iframe 守卫**：`LoginView.vue:74` 直接访问 `window.AndroidNative` 而不检查 `window === window.top`，如果 LoginView 在 iframe 中加载，Bridge 接口可被恶意页面调用
4. **Web 模式 localhost 硬编码**：`usePortForward.ts:282,295` 端口地址硬编码为 `localhost`，远程访问（非 Android App 模式）时前端无法连接实际服务器地址

**P1 级问题：**

5. **Bridge 调用无 try/catch**：`usePortForward.ts:73,82,97` 直接调用 `AndroidNative.*` 方法，WebView 未加载或接口不存在时抛出未捕获异常
6. **Bridge 调用在 Toast onClick 中**：`App.vue:568` 在 Toast 点击回调中调用 Bridge，用户快速点击可能触发多次
7. **一次性 Bridge 检测**：`useAppMode.ts:22-23` 仅在初始化时检测一次 `AndroidNative` 是否存在，如果 WebView 加载时序导致 Bridge 注入延迟，永久误判为 Web 模式
8. **Bridge 访问模式不一致**：`(window as any).AndroidNative` vs `window.AndroidNative`，部分调用绕过类型检查，部分不绕过
9. **`openPort` fallback 不捕获异常**：`usePortForward.ts:276-280` Bridge 调用失败时 fallback 到 HTTP API，但 Bridge 调用本身未 try/catch

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R12-001 | **P0** | 🛡️ 安全 | `getPassword()` 无访问控制，同源 iframe 可窃取密码 | `App.vue:577` | 实现 `AndroidNative.autoLogin(url)` 接口，消除密码明文传递；Bridge 调用需验证 caller origin |
| R12-002 | **P0** | 🛡️ 安全 | Bridge 密码明文传输，非 TLS 环境下可被中间人截获 | `App.vue:579-586` | 同 R12-001：实现 `autoLogin()` 接口，密码不离开 Native 层 |
| R12-003 | **P0** | 🛡️ 安全 | LoginView 绕过 iframe 守卫，直接访问 `window.AndroidNative` | `LoginView.vue:74` | 统一使用 `window.top.AndroidNative` 或通过 `useAppMode` 封装 |
| R12-004 | **P0** | 🛡️ 健壮性 | Web 模式 `localhost` 硬编码，远程访问时断连 | `usePortForward.ts:282,295` | 使用 `window.location.hostname` 替代硬编码 |
| R12-005 | **P1** | 🛡️ 健壮性 | Bridge 调用无 try/catch，WebView 未加载时崩溃 | `usePortForward.ts:73,82,97` | 所有 Bridge 调用包裹 try/catch，失败时降级到 HTTP API |
| R12-006 | **P1** | 🛡️ 健壮性 | Bridge 调用在 Toast onClick 中，快速点击可触发多次 | `App.vue:568` | 添加 debounce 或 loading 状态 |
| R12-007 | **P1** | 🛡️ 健壮性 | 一次性 Bridge 检测，时序竞态可能永久误判 | `useAppMode.ts:22-23` | 添加延迟重试（如 500ms 后再检测一次） |
| R12-008 | **P1** | ✨ 质量 | Bridge 访问模式不一致：`(window as any).AndroidNative` vs `window.AndroidNative` | 多文件 | 统一封装为 `AndroidNativeBridge` 接口 |
| R12-009 | **P1** | 🛡️ 健壮性 | `openPort` fallback 不捕获 Bridge 调用异常 | `usePortForward.ts:276-280` | Bridge 调用包裹 try/catch 后再 fallback |
| R12-010 | **P2** | ✨ 质量 | `window as any` 滥用 15+ 次，无类型安全接口 | 多文件 | 定义 `AndroidNativeBridge` TypeScript 接口 |
| R12-011 | **P2** | 🛡️ 健壮性 | `syncToNative` 非逐端口弹性，单个端口注册失败不重试 | `usePortForward.ts:93-99` | 逐端口 try/catch，失败端口记录并重试 |
| R12-012 | **P2** | 🛡️ 健壮性 | Bridge 调用 fire-and-forget，无确认机制 | 多文件 | 关键操作添加回调确认或超时重试 |
| R12-013 | **P2** | 🛡️ 健壮性 | `syncToNative` 错误被吞掉 | `App.vue:643` | 至少 console.error 记录 |
| R12-014 | **P2** | ✨ 质量 | Bridge 检测重复：LoginView.vue:74 和 useAppMode 独立检测 | `LoginView.vue:74`, `useAppMode.ts` | 统一通过 `useAppMode` 检测 |
| R12-015 | **P2** | 🛡️ 泄漏 | 隧道轮询 timer 可能泄漏 | `usePortForward.ts:50` | 组件卸载时确保 clearInterval |

---

## 改进建议 (Top 3)

1. **消除 Bridge 密码明文传递 (R12-001+R12-002)**: 当前 `AndroidNative.getPassword()` 返回明文密码给 JS 层，JS 再通过 HTTP 请求发送。任何同源 JS 或 iframe 都可窃取密码。建议实现 `AndroidNative.autoLogin(url)` 接口：Native 层直接执行登录请求（在 Java/Kotlin 中使用 OkHttp），获取 Cookie 后注入 WebView，密码不离开 Native 层。预期收益：消除密码明文暴露在 JS 层和 HTTP 传输中的风险。

2. **构建类型安全的 Bridge 封装 (R12-005+R12-010)**: 当前 Bridge 调用散布在多文件，`window as any` 滥用 15+ 次，无统一错误处理。建议定义 `AndroidNativeBridge` TypeScript 接口，封装所有 Bridge 调用：自动 try/catch + 降级到 HTTP API + 日志记录。统一 Bridge 访问模式（全部通过 `window.top.AndroidNative`）。预期收益：消除 Bridge 调用崩溃，提供类型安全和统一错误处理。

3. **修复 localhost 硬编码 + iframe 守卫绕过 (R12-004+R12-003)**: `usePortForward.ts:282,295` 硬编码 `localhost`，远程访问时前端无法连接；`LoginView.vue:74` 直接访问 `window.AndroidNative` 绕过 iframe 守卫。建议：(1) 使用 `window.location.hostname` 替代硬编码，自动适配本地/远程访问；(2) LoginView 统一通过 `useAppMode` 检测 Bridge，所有 Bridge 访问都经过 `window.top` 守卫。预期收益：修复远程访问断连和 iframe 安全绕过。

---

## 亮点

- **iframe 隔离设计** — `window === window.top` 是安全基石，确保 Bridge 仅在顶层窗口可用
- **三层隧道健康降级** — Native > Server > Port Active，每层独立恢复
- **data-app-mode CSS 属性** — WebView 专属样式，与 `@media (hover: hover)` 配合区分触摸/鼠标
- **App/Web 双模式 UI** — `v-if="isAppMode"` 清晰隔离，条件边界明确
