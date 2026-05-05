# iOS 客户端支持设计文档

**日期:** 2026-05-24
**方案:** Capacitor 包装 + 自定义 SSH 插件 + 沙盒 WebView
**状态:** 设计完成，待实施

---

## 1. 方案选型

| 方案 | 优势 | 劣势 | 结论 |
|------|------|------|------|
| 原生 Swift App | 完整原生能力 | 需维护两套原生代码 | ✗ |
| **Capacitor 包装** | 插件体系成熟、开发成本低、复用 Web 技术栈 | SSH 隧道需自定义插件 | **✓** |
| 纯 PWA 增强 | 零原生代码 | iOS 限制多、无 SSH 隧道 | ✗ |
| Flutter 包装 | 跨平台统一 | 现有 Android 代码需迁移 | ✗ |

**关键约束:** 开发环境为 Linux，无本地 Mac，编译/签名/上架使用云 Mac。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Capacitor iOS App                         │
│                                                              │
│  ┌──────────────────────┐   ┌────────────────────────────┐  │
│  │  主 WebView           │   │  沙盒 WebView (隔离)       │  │
│  │  (Capacitor 管理)     │   │  nonPersistentDataStore    │  │
│  │                      │   │  零共享 Cookie/Session     │  │
│  │  Vue App:            │   │                            │  │
│  │   - 聊天/文件/Git    │   │  端口转发的页面浏览        │  │
│  │   - 任务管理         │   │  (不承载 SSH)              │  │
│  │   - 端口转发 UI      │   │                            │  │
│  └──────────────────────┘   └────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────┐   ┌────────────────────────────┐  │
│  │  原生 NMSSH          │   │  Safari (外部浏览器)       │  │
│  │  OS 级别端口绑定     │   │  Browser.open() 打开       │  │
│  │  SSH -L 隧道         │──→│  访问原生 SSH 的真实端口   │  │
│  └──────────────────────┘   └────────────────────────────┘  │
│                                                              │
│  Capacitor 内置插件:                                         │
│   - Preferences (密码存储)                                   │
│   - Browser (外部浏览器)                                     │
│   - Filesystem + Share (文件下载)                            │
│   - Local Notifications (前台通知)                           │
└─────────────────────────────────────────────────────────────┘
```

### 核心原则

1. **SSH 隧道必须在原生层** — JS SSH 无法绑定 OS 级别端口，外部浏览器不可见
2. **沙盒 WebView 只负责隔离浏览** — nonPersistentDataStore 确保零状态污染
3. **前端统一抽象层屏蔽平台差异** — `useNativeBridge` 是唯一的原生调用入口
4. **Android 同步改造** — WebViewProfile 隔离浏览，逐步统一两端架构

---

## 3. 原生桥接方法映射

现有 Android `AndroidNative` 的 9 个方法重新映射：

| 方法 | Android (现有) | iOS (Capacitor) | PWA (降级) |
|------|---------------|-----------------|-----------|
| `isNativeApp()` | `AndroidNative.isNativeApp()` | `Capacitor.isNativePlatform()` | `false` |
| `addForwardedPort` | `AndroidNative.addForwardedPort()` | `ClawbenchSSH.addForwardedPort()` | no-op |
| `removeForwardedPort` | `AndroidNative.removeForwardedPort()` | `ClawbenchSSH.removeForwardedPort()` | no-op |
| `isTunnelConnected` | `AndroidNative.isTunnelConnected()` | `ClawbenchSSH.isTunnelConnected()` | `false` |
| `openInBrowser` | `AndroidNative.openInBrowser()` | `Browser.open()` (Capacitor 内置) | `window.open()` |
| `showServerDialog` | `AndroidNative.showServerDialog()` | 前端 ModalDialog | 前端 ModalDialog |
| `getPassword` | `AndroidNative.getPassword()` | `Preferences.get()` (Capacitor 内置) | `localStorage` |
| `setSSHPassword` | `AndroidNative.setSSHPassword()` | `Preferences.set()` | `localStorage` |
| `downloadFile` | `AndroidNative.downloadFile()` | `Filesystem + Share` (Capacitor 内置) | `<a download>` |

新增方法（iOS 沙盒浏览，Android 也复用）：

| 方法 | Android | iOS |
|------|---------|-----|
| `browseInSandbox` | `ClawbenchSandbox.loadUrl()` | `ClawbenchSandbox.loadUrl()` |
| `sandboxGoBack` | `ClawbenchSandbox.goBack()` | `ClawbenchSandbox.goBack()` |
| `sandboxReload` | `ClawbenchSandbox.reload()` | `ClawbenchSandbox.reload()` |

---

## 4. 前端统一抽象层 — `useNativeBridge`

### 设计目标

替代所有直接 `window.AndroidNative.xxx` 调用，作为唯一的原生交互入口。

### 接口定义

```typescript
// composables/useNativeBridge.ts

export interface NativeBridge {
  // 身份检测
  isNativeApp(): boolean
  isIOSApp(): boolean
  isAndroidApp(): boolean

  // SSH 隧道管理
  connect(options: { host: string; port: number; password: string }): Promise<void>
  disconnect(): Promise<void>
  addForwardedPort(port: number): Promise<void>
  removeForwardedPort(port: number): Promise<void>
  isTunnelConnected(): Promise<boolean>

  // 浏览
  browseInSandbox(port: number, scheme: string, path: string): Promise<void>
  sandboxGoBack(): Promise<void>
  sandboxCanGoBack(): Promise<boolean>
  sandboxReload(): Promise<void>
  openInBrowser(port: number, scheme: string): void

  // 密码
  getPassword(): Promise<string | null>
  setSSHPassword(password: string): Promise<void>

  // 文件
  downloadFile(path: string, filename: string): Promise<void>

  // 服务器配置
  showServerDialog(): void

  // 事件监听
  onTunnelStatusChanged(callback: (connected: boolean) => void): () => void
  onSandboxPageLoaded(callback: (info: { url: string; title: string }) => void): () => void
}
```

### 平台检测策略

```typescript
// 检测优先级：
// 1. Capacitor.isNativePlatform() — iOS App
// 2. window.AndroidNative?.isNativeApp() — Android App
// 3. false — PWA / 浏览器

// 注意：不能用 User-Agent 检测（iframe 会继承导致误判）
// 注意：iframe 内 (window !== window.top) 一律返回 false
```

### 对 useAppMode 的影响

```typescript
// useAppMode.ts 改造
export function useAppMode() {
  if (!initialized) {
    initialized = true
    const { isNativeApp } = useNativeBridge()
    isAppMode.value = isNativeApp()
    if (isAppMode.value) {
      document.documentElement.setAttribute('data-app-mode', '')
    }
  }
  return { isAppMode }
}
```

---

## 5. 自定义 Capacitor 插件

### 5.1 ClawbenchSSH — SSH 隧道管理

**插件 API:**

```typescript
export interface ClawbenchSSHPlugin {
  connect(options: { host: string; port: number; password: string }): Promise<void>
  disconnect(): Promise<void>
  addForwardedPort(options: { port: number }): Promise<void>
  removeForwardedPort(options: { port: number }): Promise<void>
  isTunnelConnected(): Promise<{ connected: boolean }>

  addListener(eventName: 'tunnelStatusChanged',
    listener: (status: { connected: boolean }) => void): Promise<void>
}
```

**iOS 实现 (Swift + NMSSH):**

```
plugins/clawbench-ssh/
├── ios/Sources/
│   ├── ClawbenchSSHPlugin.swift    // Capacitor 插件注册
│   └── SSHClient.swift             // NMSSH 封装
├── android/src/main/java/.../
│   ├── ClawbenchSSHPlugin.java     // Capacitor 插件注册
│   └── SSHClient.java              // JSch 封装 (复用现有 Android 逻辑)
├── src/
│   ├── definitions.ts
│   ├── index.ts
│   └── web.ts                      // PWA 降级: 抛出不支持错误
└── package.json
```

**SSH 库选择:**

| 库 | 平台 | 端口转发支持 | 维护状态 |
|----|------|-------------|---------|
| NMSSH | iOS | ✅ direct-tcpip | 不活跃但稳定 |
| JSch | Android | ✅ 完整 | 成熟 (Android 现有) |

**iOS 后台保活限制:**

iOS 不允许 App 长期后台运行，SSH 隧道在前台正常，切后台约 30s~3min 后被挂起。

策略：
1. `beginBackgroundTask` 争取额外执行时间
2. 前台恢复时自动重连（`tunnelStatusChanged` 事件通知前端）
3. 前端显示隧道状态横幅，断开时提示用户

### 5.2 ClawbenchSandbox — 隔离浏览

**插件 API:**

```typescript
export interface ClawbenchSandboxPlugin {
  loadUrl(options: { url: string }): Promise<void>
  goBack(): Promise<void>
  canGoBack(): Promise<{ canGoBack: boolean }>
  reload(): Promise<void>

  addListener(eventName: 'sandboxPageLoaded',
    listener: (info: { url: string; title: string }) => void): Promise<void>
}
```

**iOS 实现 (Swift + WKWebView):**

```swift
// 关键：nonPersistentDataStore 确保零状态共享
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = WKWebsiteDataStore.nonPersistent()
// Cookie、localStorage、SessionStorage、IndexedDB 全部独立
// WebView 销毁 = 所有状态清零

let sandboxWebView = WKWebView(frame: .zero, configuration: configuration)
sandboxWebView.customUserAgent = "ClawBench-Sandbox/1.0"
```

**Android 实现 (Kotlin + WebViewProfile):**

```kotlin
// API 33+ (Android 13+): 完全隔离
val profile = WebViewProfile.createProfile("clawbench-sandbox")
val sandboxWebView = WebView(context, profile)

// API < 33 降级: 独立 WebView + 手动清理
// 销毁时调用 WebStorage.getInstance().deleteAllData()
```

---

## 6. 沙盒 WebView + 外部浏览器双模式

### 两种浏览方式并存

| 模式 | 用途 | 状态隔离 | 能力 |
|------|------|---------|------|
| **沙盒 WebView** | 快速查看端口内容，用完即走 | 零共享 | 基础浏览 |
| **外部浏览器** | 需要完整浏览器能力、第三方登录 | Safari 独立管理 | 完整浏览器 |

### 数据流

```
用户点击端口的 "浏览" 按钮
        │
        ▼
  默认打开沙盒 WebView 内浏览
  (nonPersistent，零状态污染)
        │
        │  用户需要登录第三方
        │  或点击工具栏 ↗ 按钮
        ▼
  调用 Browser.open() → Safari 打开
  (Safari 能访问原生 SSH 绑定的真实 OS 端口)
        │
        │  用户从 Safari 返回 App
        ▼
  browserFinished 事件 → 刷新沙盒 WebView
```

### PortForwardBrowser.vue 改造

- 废弃 iframe 方案，改为驱动原生沙盒 WebView
- 新增 "在外部浏览器打开" 按钮
- 长按浏览按钮弹出选择菜单（沙盒 / 外部浏览器）

---

## 7. 文件下载

| 平台 | 实现 | 用户体验 |
|------|------|---------|
| Android | `DownloadManager` | 系统通知栏，静默下载 |
| iOS | `Filesystem.downloadFile()` + `Share.share()` | 下载 → 分享面板 → 存到文件/AirDrop |
| PWA | `<a download>` | 标准浏览器下载 |

iOS 没有 Android 式静默下载——必须经过分享面板，这是 iOS 沙盒安全模型决定的。

---

## 8. 密码存储

| 平台 | 存储 | 安全级别 |
|------|------|---------|
| Android | SharedPreferences | 明文 (现有) |
| iOS | Capacitor Preferences | 明文 (初期) |
| iOS | Keychain (@capacitor-community/keychain) | 加密 (后续迁移) |
| PWA | localStorage | 明文 |

---

## 9. 通知

**初期只做本地前台通知**，推送通知作为后续迭代。

| 能力 | Android | iOS | PWA |
|------|---------|-----|-----|
| 前台通知 | ✅ | ✅ UNUserNotificationCenter | ✅ Notification API |
| 推送通知 | ✅ FCM | 需 APNs + Apple Developer ($99/年) | ❌ iOS 不支持 |

---

## 10. showServerDialog 统一

Android 原生 Dialog → 前端 ModalDialog（iOS + PWA + 未来 Android 统一方案）。

---

## 11. 项目结构

```
clawbench/
├── cmd/server/              # Go 后端
├── internal/                # Go 后端
├── web/                     # Vue 前端
├── config/                  # 配置
├── build.sh / server.sh     # 构建/运行脚本
│
└── mobile/                  # 🆕 移动端壳
    ├── package.json
    ├── capacitor.config.ts
    │
    ├── ios/                             # Capacitor 生成的 iOS 项目
    │   └── ClawBench/
    │       ├── App/App.swift
    │       └── Pods/NMSSH
    │
    ├── android/                         # Capacitor 生成的 Android 项目
    │   └── app/src/main/java/.../MainActivity.java
    │
    └── plugins/                         # 🆕 自定义 Capacitor 插件
        ├── clawbench-ssh/
        │   ├── package.json
        │   ├── src/                     # TS 定义 + web 降级
        │   ├── ios/Sources/             # Swift + NMSSH
        │   └── android/src/.../         # Java + JSch
        │
        └── clawbench-sandbox/
            ├── package.json
            ├── src/                     # TS 定义 + web 降级
            ├── ios/Sources/             # Swift + WKWebView nonPersistent
            └── android/src/.../         # Kotlin + WebViewProfile
```

### 前端改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `composables/useNativeBridge.ts` | 🆕 新增 | 统一原生桥接抽象层 |
| `composables/useAppMode.ts` | ✏️ 修改 | 改用 useNativeBridge 检测 |
| `composables/usePortForward.ts` | ✏️ 修改 | 去掉直接 AndroidNative 调用 |
| `components/proxy/PortForwardBrowser.vue` | ✏️ 修改 | iframe → 沙盒 WebView 桥接 |
| `components/proxy/ProxyPanel.vue` | ✏️ 修改 | iOS 隧道状态展示 |
| `components/proxy/ProxyPortItem.vue` | ✏️ 修改 | 添加浏览方式选择 |
| `components/file/FileViewer.vue` | ✏️ 修改 | 下载走 useNativeBridge |
| `components/file/FileManager.vue` | ✏️ 修改 | 同上 |
| `components/file/FileHeader.vue` | ✏️ 修改 | 同上 |
| `App.vue` | ✏️ 修改 | 启动检测 + 沙盒初始化 |
| `LoginView.vue` | ✏️ 修改 | iOS 自动登录走 Preferences |

---

## 12. 开发阶段与云 Mac 使用

| 阶段 | 内容 | 需要 Mac？ | 预计工时 |
|------|------|-----------|---------|
| **P1** | `useNativeBridge.ts` 抽象层 + 前端改造 | ❌ Linux | 2-3 天 |
| **P2** | Capacitor 项目初始化 + 配置 | ❌ Linux | 0.5 天 |
| **P3** | `clawbench-ssh` 插件 Swift 代码编写 | ❌ Linux | 3-5 天 |
| **P4** | `clawbench-sandbox` 插件 Swift 代码编写 | ❌ Linux | 2-3 天 |
| **P5** | 🔄 云 Mac: 编译 + 签名 + 真机调试 | ✅ 必须 | 1-2 天 |
| **P6** | Android WebViewProfile 迁移 + Capacitor 适配 | ❌ Linux | 2-3 天 |
| **P7** | 🔄 云 Mac: iOS 全量测试 + 修复 | ✅ 必须 | 2-3 天 |
| **P8** | App Store 上架提交 | ✅ 必须 | 1-3 天 |

**云 Mac 只在 P5/P7/P8 需要**，总约 4-8 天。可用 MacinCloud (~$1/小时) 或 GitHub Actions macOS runner。

### GitHub Actions CI

```yaml
name: iOS Build
on:
  push:
    branches: [ios-support]
jobs:
  build:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install & Build
        run: |
          cd web && npm ci && npm run build
          cd ../mobile && npm ci && npx cap sync ios
      - name: Xcode Archive
        run: |
          cd mobile/ios
          xcodebuild -workspace ClawBench.xcworkspace \
            -scheme ClawBench \
            -destination 'generic/platform=iOS' \
            -archivePath build/ClawBench.xcarchive archive
```

---

## 13. 风险与待决事项

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| iOS 后台挂起 SSH 隧道 | 切后台约 30s~3min 断连 | 前台恢复自动重连 + 状态横幅提示 |
| NMSSH 维护不活跃 | 潜在安全漏洞 | SSH 协议稳定，可 fork 维护 |
| Apple 审核可能拒审加密 | 上架延迟 | 提交 ITS_Encryption 申报 |
| WebViewProfile 需 API 33+ | 老设备隔离不完整 | 降级手动清理 + 提示用户 |
| Capacitor 版本升级 | 可能破坏插件兼容 | 锁定大版本，渐进升级 |
| 无推送通知 | 定时任务结果不及时 | 后续迭代，初期用本地通知 |
