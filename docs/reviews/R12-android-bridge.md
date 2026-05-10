# R12: Android Native Bridge Review

> 日期: 2026-05-10
> 审查范围: WebView检测 → JS Bridge → 原生功能调用
> 审查人: general-purpose-12

## 审查范围

### 前端核心文件（逐行精读）

| 文件 | 行数 | 职责 |
|------|------|------|
| `web/src/composables/useAppMode.ts` | 1-40 | WebView 检测、App 模式单例 |
| `web/src/composables/usePortForward.ts` | 1-318 | 端口转发 CRUD、Bridge 调用、隧道健康检查 |
| `web/src/App.vue` | 1-810 | Bridge 编排、自动登录、端口同步 |
| `web/src/components/LoginView.vue` | 1-305 | 登录表单、Bridge 密码保存 |
| `web/src/components/proxy/ProxyPanel.vue` | 1-786 | 代理面板 UI、隧道状态展示 |

---

## 逐文件详细分析

### 1. `useAppMode.ts` (40行)

**🏗️ 架构设计：**
- 模块级单例模式正确 — `isAppMode` ref 和 `initialized` 标志确保所有消费者共享同一状态
- 双条件检测设计合理：`AndroidNative.isNativeApp()` + `window === window.top`，防止 iframe 误判
- JSDoc 注释明确说明了不检查 User-Agent 的原因（iframe 继承导致误判）
- `data-app-mode` CSS 属性设置是检测与样式解耦的好实践

**✨ 代码质量：**
- 函数短小（18行有效逻辑），职责单一
- 注释清晰，特别是 iframe 隔离原理的解释（第13-18行）
- `(window as any)` 类型不安全，但此处不可避免（Bridge 由 Native 注入）

**🛡️ 健壮性：**
- `try/catch` 处理跨域 `window.top` 访问 — 防止安全错误崩溃（第30行）
- `=== true` 严格布尔比较 — 防止 `isNativeApp()` 返回 truthy 非 boolean 值（第28行）
- **关键缺陷**：一次性检测 — `initialized = true` 后永不重试。如果 Bridge 注入晚于首次调用，永久误判为 Web 模式

---

### 2. `usePortForward.ts` (318行)

**🏗️ 架构设计：**
- 模块级共享状态（ports/sshInfo/tunnelStatus）+ 工厂函数返回操作方法 — 标准的 composable 模式
- 三层隧道健康降级设计优秀：Native > Server > Port Active，每层独立恢复
- `syncToNative` 端口同步设计正确 — 首次加载时将所有已注册端口推送到 Native 层
- **架构缺陷**：Bridge 调用散布在6个不同函数中（registerPort/unregisterPort/syncToNative/getNativeTunnelStatus/openPort/openInExternalBrowser），无统一封装

**✨ 代码质量：**
- TypeScript 接口定义完整（ForwardedPort/DetectedPort/SSHInfo/TunnelStatus）
- `getNativeTunnelStatus()` (198-209行) 有完整的 try/catch 和类型校验 — 这是 Bridge 调用的正确范例
- **代码重复**：`hasPorts/anyActive` 逻辑在 `checkTunnelHealth`(131-132, 178-179行) 和 `startTunnelPoll`(219-220, 239-240, 252行) 中重复5次
- **函数过长**：`checkTunnelHealth` 80行，混合了 Native 检测、HTTP 请求、端口探测三种逻辑
- `startTunnelPoll`(212-260行) 重复了 `checkTunnelHealth` 中的大量逻辑

**🛡️ 健壮性：**
- `registerPort`(73行) 和 `unregisterPort`(82行) 中的 Bridge 调用仅用 `?.` 可选链 — 不捕获异常
- `syncToNative`(96-98行) 顺序注册端口 — 单个端口注册异常会中断后续端口注册
- `tunnelPollTimer`(50行) 模块级变量 — 无自动清理机制，如果使用 composable 的组件卸载时未手动调用 `stopTunnelPoll`，定时器泄漏
- `openPort`(282行) 和 `openInExternalBrowser`(295行) 硬编码 `localhost` — Web 模式远程访问时断连
- `loadPorts` 的 `loading.value = true` 在 `finally` 中重置，但 `loadPorts(true)` (静默模式) 跳过 loading 状态 — 设计合理
- `loadSSHInfo`(106行) 的空 catch 正确 — SSH 信息获取失败不应阻断功能

---

### 3. `App.vue` (810行)

**🏗️ 架构设计：**
- 抽屉互斥模式（294-336行）设计清晰 — `drawerStates` 映射表 + `ensureDrawerOpen` 统一控制
- 三态认证（`null`/`true`/`false`）正确处理加载中/已认证/未认证
- **架构缺陷**：`onMounted`（556-666行）110行的"上帝函数"，承担了：认证检查、自动登录、Mermaid初始化、会话初始化、未读检查、端口同步、项目加载、文件加载、上次文件恢复 — 9个职责

**✨ 代码质量：**
- App/Web 模式的差异化 Toast 消息（565-572行）— 用户体验考虑周到
- `syncToNative().catch(() => {})`(643行) — 错误被静默吞掉，至少应 `console.error`
- `window.AndroidNative` 直接访问（565, 568, 579, 591行）绕过了 `useAppMode` 的封装

**🛡️ 健壮性：**
- 自动登录流程（579-606行）**密码明文传递**：`getPassword()` 返回明文 → JS 层持有 → `fetch('/login')` HTTP 传输。非 TLS 环境下可被中间人截获
- 自动登录**直接访问 Bridge**（579行）：`window.AndroidNative?.getPassword?.()` 未检查 `window === window.top`，iframe 中可被恶意页面调用
- Toast onClick 中的 Bridge 调用（568行）：`window.AndroidNative.showServerDialog()` — 快速点击可触发多次，且无 try/catch
- `syncToNative().catch(() => {})`(643行) — 同步失败被静默忽略
- `isAuthenticated` 在 `fetch('/api/me')` 网络错误时设为 `false`(564行) — 正确，不会卡在 null 状态

---

### 4. `LoginView.vue` (305行)

**🏗️ 架构设计：**
- 纯 UI 组件，通过 `emit('loginSuccess')` 通知父组件 — 职责清晰
- 表单状态管理简洁（password/loading/error）

**✨ 代码质量：**
- `type="password"` + `autocomplete="current-password"` — 安全属性正确
- `@submit.prevent` 阻止默认表单提交 — 正确
- 304行中约215行是 CSS（70%）— 样式与逻辑比例严重失衡，但这是独立登录页面的常见情况

**🛡️ 健壮性：**
- **关键安全缺陷**（74行）：`window.AndroidNative?.isNativeApp?.()` 直接检测 Bridge，**未检查 `window === window.top`**。如果 LoginView 在 iframe 中加载，恶意父页面可以：
  1. 让 iframe 加载 LoginView
  2. 等待用户输入密码
  3. 通过 `window.AndroidNative.getPassword()` 窃取密码（因为 Bridge 注入到所有 frame）
- **密码明文存储**（75行）：`window.AndroidNative.setSSHPassword(password.value)` 将明文密码保存到 Android SharedPreferences — root 设备上其他应用可读取
- 登录请求（67-71行）通过 `fetch('/login')` 发送 JSON 密码 — 依赖 HTTPS 保护，非 TLS 环境不安全
- 无登录失败次数限制 — 可暴力破解

---

### 5. `ProxyPanel.vue` (786行)

**🏗️ 架构设计：**
- 通过 `usePortForward()` composable 获取所有状态和操作 — 关注点分离良好
- App/Web 模式条件渲染清晰（`v-if="isAppMode"` / `v-if="!isAppMode"`）
- 隧道状态可视化（disconnected/degraded/ok）— 三态 UI 映射到三态健康模型

**✨ 代码质量：**
- `detectedPortsNotRegistered` computed 正确过滤已注册端口（211-214行）
- `isValidPort` computed 验证端口范围（206-209行）
- `handleRetryTunnel`(250-267行) 的状态变更 Toast 反馈设计完善
- 786行中约510行是 CSS（65%）— 考虑提取样式到独立文件
- CSS 中大量硬编码颜色值（如 `#ef4444`, `#3b82f6`）未使用 CSS 变量

**🛡️ 健壮性：**
- `copySSHCommand`(241-248行) 使用 `navigator.clipboard.writeText` — 需要安全上下文（HTTPS 或 localhost），HTTP 远程访问时静默失败（空 catch）
- `handleAdd`(216-222行) 注册端口后清空表单 — 如果 `registerPort` 失败，表单已清空但端口未添加
- `handleDetect` 的 `detecting` 状态在 `finally` 中重置 — 正确，不会卡住
- Watch `props.open`(269-273行) 触发 `checkTunnelHealth` — 每次打开面板都重新检查，合理

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.0/10

**优势：**
- `useAppMode` 单例模式 + 双条件 iframe 防护是安全基石
- 三层隧道健康降级（Native > Server > Port Active）设计成熟
- App/Web 双模式 UI 通过 `v-if="isAppMode"` 清晰隔离
- `data-app-mode` CSS 属性实现 WebView 专属样式，与 `@media (hover: hover)` 配合

**问题：**
- Bridge 调用散布在4个文件6+个函数中，无统一封装层 — 新增 Bridge 方法时需要搜索所有文件
- `App.vue` 的 `onMounted` 承担9个职责，是"上帝函数"的反模式
- `usePortForward` 同时管理 API 调用和 Bridge 调用，两种通信模式混合在同一 composable 中
- `getNativeTunnelStatus` 是唯一正确封装的 Bridge 调用（有 try/catch + 类型校验），其他调用均无此保护 — 封装标准不一致

### ✨ 代码质量 (30%) — 评分: 6.5/10

**优势：**
- TypeScript 接口定义完整（ForwardedPort/DetectedPort/SSHInfo/TunnelStatus）
- `getNativeTunnelStatus` 是 Bridge 调用的正确范例
- JSDoc 注释质量高，特别是 iframe 隔离原理
- 隧道健康三态模型（unknown/ok/disconnected/degraded）语义清晰

**问题：**
- `(window as any).AndroidNative` 出现8次，`window.AndroidNative` 出现3次 — 两种访问模式不一致
- `checkTunnelHealth` 80行函数过长，`startTunnelPoll` 重复了其中大量逻辑
- `hasPorts/anyActive` 判断重复5次，应提取为辅助函数
- ProxyPanel.vue CSS 占比65%，硬编码颜色值未使用 CSS 变量
- `syncToNative().catch(() => {})` 静默吞掉错误

### 🛡️ 健壮性 (40%) — 评分: 5.0/10

**严重问题：**
- 密码明文通过 Bridge 传递到 JS 层，再通过 HTTP 传输 — 非TLS环境下完全暴露
- LoginView 直接访问 `window.AndroidNative` 绕过 iframe 守卫 — 同源 iframe 可窃取密码
- Web 模式端口地址硬编码 `localhost` — 远程访问时功能失效
- 一次性 Bridge 检测无重试机制 — Bridge 注入时序竞态导致永久误判
- `tunnelPollTimer` 无自动清理 — 模块级定时器可能泄漏
- Bridge 调用（除 `getNativeTunnelStatus` 外）无 try/catch — 异常未捕获

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R12-001 | **P0** | 🛡️ 安全 | `getPassword()` 返回明文密码到 JS 层，同源 iframe 可窃取。Bridge 注入到所有 frame，`window.AndroidNative.getPassword()` 在 iframe 中也可调用 | `App.vue:579` | 实现 `AndroidNative.autoLogin(url)` 接口：Native 层直接执行登录请求，获取 Cookie 后注入 WebView，密码不离开 Native 层 |
| R12-002 | **P0** | 🛡️ 安全 | 密码明文通过 HTTP 传输。`fetch('/login', { body: JSON.stringify({ password: savedPwd }) })` 在非 TLS 环境下可被中间人截获 | `App.vue:583-586` | 同 R12-001：autoLogin 在 Native 层完成，不经过 JS/HTTP |
| R12-003 | **P0** | 🛡️ 安全 | LoginView 直接访问 `window.AndroidNative` 绕过 `window === window.top` iframe 守卫。`isNativeApp()` 和 `setSSHPassword()` 在 iframe 上下文中也可被调用 | `LoginView.vue:74-75` | 统一通过 `useAppMode()` 检测和调用 Bridge，所有 Bridge 访问经过 `window.top` 守卫 |
| R12-004 | **P0** | 🛡️ 安全 | `setSSHPassword()` 将明文密码存入 Android SharedPreferences（XML 文件），root 设备上其他应用可读取 | `LoginView.vue:75`, `App.vue:591` | 使用 Android EncryptedSharedPreferences 或 Android Keystore 加密存储 |
| R12-005 | **P0** | 🛡️ 健壮性 | Web 模式 `localhost` 硬编码。远程访问（非 Android App）时 `window.open('http://localhost:PORT')` 无法连接实际服务器 | `usePortForward.ts:282,295` | 使用 `window.location.hostname` 替代硬编码，自动适配本地/远程访问 |
| R12-006 | **P1** | 🛡️ 健壮性 | Bridge 调用无 try/catch。`registerPort`(73行)、`unregisterPort`(82行)、`syncToNative`(97行) 中 `(window as any).AndroidNative?.addForwardedPort(port)` 仅用 `?.` 防空，不捕获异常。Native 层抛出异常时前端崩溃 | `usePortForward.ts:73,82,97` | 所有 Bridge 调用包裹 try/catch，参考 `getNativeTunnelStatus`(198-209行) 的正确做法 |
| R12-007 | **P1** | 🛡️ 健壮性 | 一次性 Bridge 检测无重试。`useAppMode.ts:23` 设置 `initialized = true` 后永不重试。Android WebView Bridge 注入可能在 `DOMContentLoaded` 之后完成，导致永久误判为 Web 模式 | `useAppMode.ts:22-23` | 添加延迟重试（如 500ms 后再检测一次），或监听 Bridge 注入事件 |
| R12-008 | **P1** | 🛡️ 泄漏 | `tunnelPollTimer` 模块级定时器无自动清理。`usePortForward` 是模块级单例，其 `tunnelPollTimer` 在应用生命周期内永不清理。虽然应用级单例通常与页面同生命周期，但如果未来改为组件级使用则会泄漏 | `usePortForward.ts:50,212-260` | 提供 `cleanup()` 方法并在适当时机调用；或在 `startTunnelPoll` 中使用 `watchEffect` 自动清理 |
| R12-009 | **P1** | 🛡️ 健壮性 | Toast onClick 中调用 Bridge，快速点击可触发多次 `showServerDialog()` | `App.vue:568` | 添加 debounce 或 loading 状态防止重复触发 |
| R12-010 | **P1** | 🛡️ 健壮性 | `syncToNative` 顺序注册端口，单个端口 `addForwardedPort` 抛异常会中断后续端口注册 | `usePortForward.ts:93-99` | 逐端口 try/catch，失败端口记录并重试 |
| R12-011 | **P1** | ✨ 质量 | Bridge 访问模式不一致：`(window as any).AndroidNative` (8次) vs `window.AndroidNative` (3次)。前者绕过类型检查，后者在严格模式下编译报错 | 多文件 | 统一封装为类型安全的 `AndroidNativeBridge` 接口 |
| R12-012 | **P2** | ✨ 质量 | `window as any` 滥用 8+ 次，无类型安全接口。Bridge 方法名、参数类型、返回值类型全部丢失 | 多文件 | 定义 `AndroidNativeBridge` TypeScript 接口，声明 `Window` 扩展 |
| R12-013 | **P2** | ✨ 质量 | `checkTunnelHealth` 80行函数过长，混合 Native 检测、HTTP 请求、端口探测三种逻辑。`startTunnelPoll` 重复了其中大量判断逻辑 | `usePortForward.ts:112-192,212-260` | 提取 `determineTunnelStatus(nativeConnected, sshInfo, ports)` 纯函数，`checkTunnelHealth` 和 `startTunnelPoll` 共用 |
| R12-014 | **P2** | ✨ 质量 | `hasPorts/anyActive` 判断逻辑重复5次 | `usePortForward.ts:131,163,179,219,239,252` | 提取为 `computePortHealth(ports)` 辅助函数 |
| R12-015 | **P2** | ✨ 质量 | `syncToNative().catch(() => {})` 静默吞掉错误 | `App.vue:643` | 至少 `console.error` 记录，方便调试 |
| R12-016 | **P2** | 🛡️ 健壮性 | `handleAdd` 先清空表单再等 `registerPort` 完成。如果 `registerPort` 失败，表单已清空但端口未添加 | `ProxyPanel.vue:216-222` | 先 await registerPort，成功后再清空表单 |
| R12-017 | **P2** | 🛡️ 健壮性 | `copySSHCommand` 使用 `navigator.clipboard.writeText`，HTTP 远程访问时（非安全上下文）API 不可用，空 catch 导致用户无反馈 | `ProxyPanel.vue:241-248` | 检测 `navigator.clipboard` 可用性，不可用时 fallback 到 `document.execCommand('copy')` 或显示提示 |
| R12-018 | **P2** | ✨ 质量 | ProxyPanel.vue CSS 占 65%，硬编码颜色值（`#ef4444`, `#3b82f6`, `#8b5cf6`）未使用 CSS 变量 | `ProxyPanel.vue:299-599` | 提取颜色为 CSS 变量，便于主题适配 |
| R12-019 | **P2** | ✨ 质量 | `App.vue` onMounted 110行承担9个职责（认证、自动登录、初始化、会话、未读检查、端口同步、项目加载、文件加载、文件恢复） | `App.vue:556-666` | 拆分为独立 composable：`useAutoLogin()`、`useAppInit()` |
| R12-020 | **P3** | ✨ 质量 | Bridge 检测在 LoginView 和 useAppMode 中重复。LoginView:74 独立调用 `isNativeApp()` 而非使用 `useAppMode()` | `LoginView.vue:74` | 统一通过 `useAppMode()` 检测 |
| R12-021 | **P3** | ✨ 质量 | `useAppMode.ts:5` `initialized` 标志在 HMR 时不会重置，开发时切换 Bridge 状态需要刷新页面 | `useAppMode.ts:5` | 开发模式下允许重置（`if (import.meta.hot) initialized = false`） |
| R12-022 | **P3** | 🛡️ 健壮性 | LoginView 无登录失败次数限制，可暴力破解密码 | `LoginView.vue:62-88` | 添加客户端节流（如5次失败后等待30秒），后端也应实现 rate limiting |
| R12-023 | **P3** | 🛡️ 健壮性 | `loadPorts` 错误未传播 — `apiGet` 失败时 `ports.value` 保持旧值，用户不知道数据可能过时 | `usePortForward.ts:59-67` | 失败时设置错误状态，UI 可展示"加载失败"提示 |

---

## 改进建议 (Top 3)

1. **消除 Bridge 密码明文传递 (R12-001 + R12-002 + R12-003 + R12-004)**: 当前密码通过 `getPassword()` 明文传递到 JS 层，再通过 HTTP 发送，且 `setSSHPassword()` 明文存储到 SharedPreferences。建议：(1) 实现 `AndroidNative.autoLogin(url)` 接口，Native 层直接执行登录请求（OkHttp），获取 Cookie 后注入 WebView，密码不离开 Native 层；(2) 使用 Android EncryptedSharedPreferences 或 Keystore 加密存储密码；(3) LoginView 统一通过 `useAppMode()` 访问 Bridge，所有 Bridge 调用经过 `window.top` 守卫。预期收益：消除密码在 JS 层暴露、HTTP 传输和本地存储中的三个安全风险点。

2. **构建类型安全的 Bridge 封装层 (R12-006 + R12-011 + R12-012)**: 当前 Bridge 调用散布在4个文件中，`window as any` 滥用，仅 `getNativeTunnelStatus` 有完整的 try/catch + 类型校验。建议：(1) 定义 `AndroidNativeBridge` TypeScript 接口（声明 Window 扩展）；(2) 封装统一的 Bridge 调用函数，自动 try/catch + 降级 + 日志；(3) 所有 Bridge 访问通过 `window.top` 守卫。以 `getNativeTunnelStatus` 为模板统一封装。预期收益：消除 Bridge 调用崩溃风险，提供类型安全和统一错误处理，降低新增 Bridge 方法的维护成本。

3. **修复 localhost 硬编码 + 提取隧道健康公共逻辑 (R12-005 + R12-013 + R12-014)**: Web 模式端口地址硬编码 `localhost`，远程访问功能失效；`checkTunnelHealth` 和 `startTunnelPoll` 中 `hasPorts/anyActive` 判断重复5次。建议：(1) 使用 `window.location.hostname` 替代硬编码；(2) 提取 `determineTunnelStatus(nativeConnected, sshInfo, ports)` 纯函数；(3) 提取 `computePortHealth(ports)` 辅助函数。预期收益：修复远程访问断连，减少 ~60 行重复代码，降低隧道健康逻辑的维护成本。

---

## 亮点

- **iframe 隔离设计** — `window === window.top` 是安全基石，`useAppMode` 的 JSDoc 注释精确解释了为什么不检查 User-Agent，设计决策有据可查
- **三层隧道健康降级** — Native > Server > Port Active，每层独立恢复，`getNativeTunnelStatus` 是 Bridge 调用的正确范例（try/catch + 类型校验 + null 降级）
- **data-app-mode CSS 属性** — WebView 专属样式与 `@media (hover: hover)` 触摸设备检测配合，双维度区分设备类型
- **App/Web 双模式 UI** — `v-if="isAppMode"` 清晰隔离，Toast 消息、隧道状态、SSH 指南等均有差异化处理
- **端口自动检测** — `/api/proxy/detect` 扫描 + 未注册端口过滤 + 快速添加芯片，用户体验流畅
