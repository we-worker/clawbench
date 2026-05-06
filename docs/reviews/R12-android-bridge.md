# R12: Android Native Bridge Review

> 日期: 2026-05-24
> 审查范围: WebView检测 → JS Bridge → 原生功能调用

## 审查范围

### 前端
- `web/src/composables/useAppMode.ts` (1-39) — App 模式检测
- `web/src/composables/usePortForward.ts` (1-319) — 端口转发状态 + Bridge 调用
- `web/src/App.vue` (1-844) — 主应用编排 + Android 自动登录
- `web/src/components/LoginView.vue` (1-155) — 登录 + Bridge 密码保存
- `web/src/components/proxy/ProxyPanel.vue` (1-786) — 端口转发面板

---

## 三维度评估

### 🏗️ 架构设计 (30%) — 评分: 7.5/10

**iframe 隔离设计是安全基石：** `useAppMode` 的 `window === window.top` 检查确保只有顶层 frame 才被识别为 App 模式，防止端口转发的第三方页面误触发原生功能。

**三层隧道健康降级：** Native 状态 > 服务端连接统计 > 端口活跃检测，逻辑清晰。

**`data-app-mode` CSS 属性标记：** WebView 专属样式只需 `[data-app-mode] .foo { ... }`，不侵入 JS 逻辑。

**关注点：**
- Bridge 调用散落在 5 个文件中，无统一封装层，错误处理不一致
- `window as any` 滥用（15+ 次），完全绕过类型系统
- App/Web 双模式逻辑通过 `v-if="isAppMode"` 分界，但部分代码路径未完全隔离

### ✨ 代码质量 (30%) — 评分: 7.0/10

**亮点：**
- `usePortForward.ts` 的隧道健康检查逻辑清晰，有注释说明三层降级策略
- ProxyPanel 的 App/Web 双模式 UI 清晰分界

**关注点：**
- `checkTunnelHealth` 过长（80行），多层 if-else，可拆分
- ProxyPanel.vue 786 行中约 500 行是 CSS（63%），应提取
- `(window as any).AndroidNative` 类型断言缺乏统一接口定义

### 🛡️ 健壮性 (40%) — 评分: 6.0/10

**P0 级问题：**

1. **密码明文通过 Bridge 传输**：`getPassword()` 返回明文密码，`setSSHPassword()` 传递明文。同源 JS（包括被 XSS 注入的脚本）可调用这些方法窃取或覆盖密码

**P1 级问题：**

2. **Bridge 检测异常无降级提示**：`isNativeApp()` 抛异常时被外层 catch 吞掉，App 模式用户看不到任何原生功能也无提示
3. **getPassword 无访问控制**：任何同源 JS 都可调用

**P2 级问题：**

4. **Bridge 调用无错误反馈**：`addForwardedPort` 等使用可选链调用，失败时静默忽略
5. **Web 模式 localhost 硬编码**：远程部署场景下 `localhost` 指向用户本机
6. **Bridge 调用嵌入 Toast onClick**：Bridge 不存在时点击抛异常

---

## 问题清单

| ID | 严重度 | 类别 | 描述 | 文件:行号 | 建议 |
|----|--------|------|------|-----------|------|
| R12-001 | **P0** | 🛡️ 安全 | Bridge 密码明文传输，可被同源 JS 窃取/篡改 | `LoginView.vue:47-48`, `App.vue:578-590` | 实现 Native 侧自动登录接口 |
| R12-002 | **P1** | 🛡️ 健壮性 | Bridge 检测异常无降级提示，原生功能静默失效 | `useAppMode.ts:24-32` | 分离 try-catch，异常时 warn 日志 |
| R12-003 | **P1** | 🛡️ 安全 | getPassword 无访问控制 | `App.vue:577` | Native 侧实现访问控制 |
| R12-004 | **P2** | 🛡️ 健壮性 | Bridge 调用无错误反馈 | `usePortForward.ts:73,82,97` | 返回 boolean 或 toast 提示 |
| R12-005 | **P2** | 🛡️ 健壮性 | Web 模式 localhost 硬编码 | `usePortForward.ts:282` | 使用 `window.location.hostname` |
| R12-006 | **P2** | 🛡️ 健壮性 | Bridge 调用嵌入 Toast onClick 无空检查 | `App.vue:563-566` | 添加 Bridge 可用性检查 |
| R12-007 | **P2** | ✨ 质量 | `window as any` 滥用 15+ 次 | 多文件 | 定义 AndroidNativeBridge 接口 |
| R12-008 | **P2** | ✨ 质量 | `checkTunnelHealth` 过长 80 行 | `usePortForward.ts:112-192` | 拆分为子函数 |
| R12-009 | **P3** | 🛡️ 健壮性 | App 模式初始化不可重试 | `useAppMode.ts:5` | 提供 resetAppMode() 方法 |
| R12-010 | **P3** | 🛡️ 泄漏 | tunnelPollTimer HMR 场景可能泄漏 | `usePortForward.ts:50` | 在 startTunnelPoll 中清除旧定时器 |

---

## 改进建议 (Top 3)

1. **消除 Bridge 密码明文传递 (R12-001)**: 实现 `AndroidNative.autoLogin(url)` 接口，原生层直接发起 HTTP 认证请求返回 session cookie，彻底避免密码经过 JS 层。预期收益：消除最严重的 Bridge 安全漏洞。

2. **建立类型安全的 Bridge 封装层 (R12-002+R12-004+R12-007)**: 定义 `AndroidNativeBridge` 接口，在 `useAppMode` 中提供统一 getter（含 try-catch + 降级日志），所有调用点通过 getter 访问而非 `window as any`。预期收益：类型安全 + 统一错误处理 + 可测试性。

3. **修复 Web 模式 localhost 硬编码 (R12-005)**: `localhost` → `window.location.hostname`，一行改动但影响所有远程部署用户。预期收益：远程部署场景下端口转发可用。

---

## 亮点

- **iframe 隔离设计**：`window === window.top` 是整个 Bridge 安全体系的基石
- **三层隧道健康降级**：Native > Server > Port Active，考虑多种故障场景
- **`data-app-mode` CSS 属性标记**：WebView 专属样式不侵入 JS 逻辑
- **App/Web 双模式 UI**：ProxyPanel 中 `v-if` 清晰分界，体验针对性强
