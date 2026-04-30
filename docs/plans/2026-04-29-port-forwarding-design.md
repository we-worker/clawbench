# 端口转发功能 — 完整实施方案

> 日期：2026-04-29
> 状态：已确认，待实施
> 实施方式：在 git worktree 中开发

---

## 1. 问题陈述

ClawBench Android 客户端是 WebView 壳，连接远程 ClawBench 服务器。当 AI Agent 在服务器上启动 HTTP/WebSocket 服务（如 `npm run dev` 在 `:5173`），Android 设备无法直接访问：

- `localhost:5173` 是服务器的 localhost，不是手机的
- 即使通过网络 IP 访问，可能存在防火墙/CORS/HTTPS 混合内容问题
- WebView 的 `shouldOverrideUrlLoading` 会将非同源链接踢到系统浏览器

## 2. 核心原理

VS Code 端口转发效果：远程 `:5173` → 本地 `localhost:5173`，用户无感知。

**方案：Android `shouldInterceptRequest` + Go 反向代理 + JS 注入**

```
WebView 中代码访问 http://localhost:5173/index.html
     ↓ shouldInterceptRequest 拦截
     ↓ 转发到 Go 服务器 /api/proxy/forward/5173/index.html
     ↓ Go 代理到 http://127.0.0.1:5173/index.html
     ↓ 响应原路返回 → WebView 正常渲染
```

三个拦截层协同工作：

| 层 | 拦截对象 | 处理方式 |
|---|---|---|
| **Android `shouldInterceptRequest`** | GET 子资源（script/css/img/xhr GET） | 转发到 Go `/api/proxy/forward/{port}/...` |
| **JS `fetch()`/`XHR` 拦截** | JS 发起的请求（含 POST body） | URL 重写：`localhost:{port}` → `{server}/api/proxy/forward/{port}/...` |
| **JS `WebSocket` 拦截** | `ws://localhost:{port}` | URL 重写：→ `wss://{server}/api/proxy/ws/{port}/...` |

**关键优势**：WebView 中的代码仍然访问 `localhost:5173`，URL 完全不变，不需要 HTML 重写，和 VS Code 效果一致。

## 3. 技术决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| Android HTTP 客户端 | `java.net.HttpURLConnection` | 无需引入 OkHttp（~400KB），shouldInterceptRequest 在后台线程同步阻塞即可 |
| Go WebSocket 库 | `gorilla/websocket` | 最成熟的 Go WS 库，代理中继场景首选 |
| 请求转发协议 | 路径编码 `/api/proxy/forward/{port}/path` | 简单可调试，无需自定义 header |
| POST body 处理 | JS 层 fetch/XHR 拦截重写 URL | Android `WebResourceRequest` 不暴露 POST body，JS 层重写让请求直接走代理 |
| 自动端口检测 | Linux `/proc/net/tcp`，macOS `lsof` | 仅列出建议，不自动转发（和 VS Code 行为一致） |
| HTML 重写 | 不需要 | shouldInterceptRequest 会拦截所有子资源请求，循环拦截 |
| 代理认证 | Cookie 转发 | Android 通过 `CookieManager.getInstance().getCookie()` 读取 WebView cookie |

## 4. 数据流详解

### 4.1 GET 子资源请求（script/css/img/xhr GET）

```
WebView 加载 http://localhost:5173/app.js
  → shouldInterceptRequest 拦截（host=localhost, port=5173, 已注册）
  → HttpURLConnection GET https://server/api/proxy/forward/5173/app.js
     (携带 Cookie: clawbench_session=xxx)
  → Go handler: middleware.Auth 验证 cookie
  → Go handler: 解析 port=5173, 校验已注册+允许
  → Go handler: http.NewRequest("GET", "http://127.0.0.1:5173/app.js")
  → Go handler: 流式写入响应 body（32KB buffer + Flush）
  → Android: 构造 WebResourceResponse(contentType, encoding, status, headers, body)
  → WebView 渲染
```

### 4.2 fetch/XHR 请求（含 POST body）

```
JS: fetch('http://localhost:3000/api/users', {method:'POST', body:JSON.stringify(...)})
  → JS 拦截: 检测 hostname=localhost, port=3000
  → URL 重写: fetch('https://server/api/proxy/forward/3000/api/users', {method:'POST', body:...})
  → 浏览器正常发起请求（同源，自动携带 cookie）
  → Go handler: 代理到 http://127.0.0.1:3000/api/users
  → 响应返回给 JS
```

### 4.3 WebSocket 请求

```
JS: new WebSocket('ws://localhost:5173/ws')
  → JS 拦截: 检测 hostname=localhost, port=5173, protocol=ws
  → URL 重写: new WebSocket('wss://server/api/proxy/ws/5173/ws')
  → 浏览器发起 WS 升级请求（同源，自动携带 cookie）
  → Go handler: middleware.Auth 验证 cookie
  → Go handler: gorilla/websocket 升级客户端连接
  → Go handler: 同时拨号 ws://127.0.0.1:5173/ws
  → Go handler: 双 goroutine 双向中继
```

---

## 5. 后端设计（Go）

### 5.1 新建文件

#### `internal/model/proxy.go`

```go
package model

// ForwardedPort represents a registered forwarded port.
type ForwardedPort struct {
    Port       int    `json:"port"`       // Local port number (e.g. 5173)
    Name       string `json:"name"`       // User-friendly name (e.g. "Vite Dev Server")
    AutoDetect bool   `json:"autoDetect"` // Whether this was auto-detected
    Active     bool   `json:"active"`     // Whether the port is currently listening
}

// ProxyConfig holds the proxy section from config.yaml.
type ProxyConfig struct {
    Enabled      bool   `yaml:"enabled"`       // Enable/disable port forwarding (default: true)
    AllowedPorts string `yaml:"allowed_ports"` // "1024-65535" or "3000,5173,8080" (default: "1024-65535")
}
```

全局变量：`var ProxyAllowedPorts = "1024-65535"`

#### `internal/service/proxy.go`

端口注册服务，线程安全（`sync.RWMutex` + `map[int]*ForwardedPort`）：

```go
type ProxyRegistry struct {
    mu      sync.RWMutex
    ports   map[int]*model.ForwardedPort
    cfg     model.ProxyConfig
    cancel  context.CancelFunc
    selfPort int  // ClawBench 自身端口，排除
}

func NewProxyRegistry(cfg model.ProxyConfig, selfPort int) *ProxyRegistry
func (r *ProxyRegistry) RegisterPort(port int, name string) error
func (r *ProxyRegistry) UnregisterPort(port int) error
func (r *ProxyRegistry) ListPorts() []model.ForwardedPort
func (r *ProxyRegistry) IsPortAllowed(port int) bool
func (r *ProxyRegistry) IsPortRegistered(port int) bool
func (r *ProxyRegistry) DetectListeningPorts() []int  // /proc/net/tcp or lsof
func (r *ProxyRegistry) Stop()
```

**端口白名单解析** `AllowedPorts`：
- `"1024-65535"` → 解析为范围，允许 1024-65535
- `"3000,5173,8080"` → 解析为离散列表
- `""` → 默认 `1024-65535`

**健康检查**：每个注册端口一个 goroutine，每 5 秒 `net.DialTimeout("tcp", "127.0.0.1:{port}", 2s)`。

**自动检测** `DetectListeningPorts()`：
- Linux: 解析 `/proc/net/tcp`，提取 state=0A(LISTEN) 的行，hex 端口→十进制，过滤 < 1024 和自身端口
- macOS: 执行 `lsof -iTCP -sTCP:LISTEN -P -n`，解析输出
- Windows: 执行 `netstat -ano | findstr LISTENING`，解析输出

全局单例：`var ProxyService *ProxyRegistry`

#### `internal/handler/proxy_api.go`

CRUD API handlers：

| Handler | 方法+路径 | 说明 |
|---------|----------|------|
| `ServeProxyPorts` | GET `/api/proxy/ports` | 列出已注册端口+健康状态 |
| `ServeProxyPortRegister` | POST `/api/proxy/ports` | 注册端口 `{"port":5173,"name":"Vite"}` |
| `ServeProxyPortUnregister` | DELETE `/api/proxy/ports/{port}` | 删除注册（从 URL 手动解析 port） |
| `ServeProxyDetect` | GET `/api/proxy/detect` | 返回自动检测到的监听端口列表 |

POST handler 示例：
```go
func ServeProxyPortRegister(w http.ResponseWriter, r *http.Request) {
    if !requireMethod(w, r, http.MethodPost) { return }
    var req struct {
        Port int    `json:"port"`
        Name string `json:"name"`
    }
    if !decodeJSON(w, r, &req) { return }
    if req.Port <= 0 || req.Port > 65535 {
        model.WriteErrorf(w, http.StatusBadRequest, "Invalid port number")
        return
    }
    if err := service.ProxyService.RegisterPort(req.Port, req.Name); err != nil {
        model.WriteErrorf(w, http.StatusForbidden, err.Error())
        return
    }
    writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
```

#### `internal/handler/proxy.go`

**HTTP 反向代理 `ServeProxyForward`：**

```go
func ServeProxyForward(w http.ResponseWriter, r *http.Request) {
    // 1. 解析端口：/api/proxy/forward/{port}/rest/of/path
    pathAfterPrefix := strings.TrimPrefix(r.URL.Path, "/api/proxy/forward/")
    parts := strings.SplitN(pathAfterPrefix, "/", 2)
    port, err := strconv.Atoi(parts[0])
    if err != nil { model.WriteErrorf(w, 400, "Invalid port"); return }

    // 2. 校验
    if !service.ProxyService.IsPortAllowed(port) { model.WriteErrorf(w, 403, "Port not allowed"); return }
    if !service.ProxyService.IsPortRegistered(port) { model.WriteErrorf(w, 403, "Port not registered"); return }

    // 3. 构造目标
    targetPath := "/"
    if len(parts) > 1 { targetPath += parts[1] }
    targetURL := fmt.Sprintf("http://127.0.0.1:%d%s", port, targetPath)
    if r.URL.RawQuery != "" { targetURL += "?" + r.URL.RawQuery }

    // 4. 创建代理请求
    proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
    if err != nil { model.WriteErrorf(w, 500, "Proxy request error"); return }

    // 5. 复制 header（过滤 hop-by-hop）
    copyHeaders(proxyReq.Header, r.Header)
    proxyReq.Header.Set("X-Forwarded-For", r.RemoteAddr)
    proxyReq.Header.Set("X-Forwarded-Proto", "http")

    // 6. 执行
    resp, err := http.DefaultClient.Do(proxyReq)
    if err != nil { model.WriteErrorf(w, 502, "Backend unreachable"); return }
    defer resp.Body.Close()

    // 7. 复制响应 header
    for k, vv := range resp.Header {
        for _, v := range vv { w.Header().Add(k, v) }
    }

    // 8. 流式写入（支持 SSE 等流式协议）
    w.WriteHeader(resp.StatusCode)
    flusher, canFlush := w.(http.Flusher)
    buf := make([]byte, 32*1024)
    for {
        n, err := resp.Body.Read(buf)
        if n > 0 {
            w.Write(buf[:n])
            if canFlush { flusher.Flush() }
        }
        if err != nil { break }
    }
}
```

**Hop-by-hop headers 过滤** (RFC 2616 Section 13.5.1)：
```go
var hopByHopHeaders = []string{
    "Connection", "Keep-Alive", "Proxy-Authenticate",
    "Proxy-Authorization", "TE", "Trailers",
    "Transfer-Encoding", "Upgrade",
}
```

**WebSocket 中继 `ServeProxyWebSocket`：**

```go
var upgrader = websocket.Upgrader{
    CheckOrigin: func(r *http.Request) bool { return true },
    ReadBufferSize:  4096,
    WriteBufferSize: 4096,
}

func ServeProxyWebSocket(w http.ResponseWriter, r *http.Request) {
    // 1. 解析端口
    pathAfterPrefix := strings.TrimPrefix(r.URL.Path, "/api/proxy/ws/")
    parts := strings.SplitN(pathAfterPrefix, "/", 2)
    port, _ := strconv.Atoi(parts[0])

    // 2. 校验
    if !service.ProxyService.IsPortAllowed(port) || !service.ProxyService.IsPortRegistered(port) { ... }

    // 3. 拨号到后端
    targetPath := "/"
    if len(parts) > 1 { targetPath += parts[1] }
    targetURL := fmt.Sprintf("ws://127.0.0.1:%d%s", port, targetPath)
    backendConn, _, err := websocket.DefaultDialer.Dial(targetURL, nil)
    if err != nil { ... }
    defer backendConn.Close()

    // 4. 升级客户端
    clientConn, err := upgrader.Upgrade(w, r, nil)
    if err != nil { ... }
    defer clientConn.Close()

    // 5. 双向中继
    var wg sync.WaitGroup
    wg.Add(2)
    go func() { defer wg.Done(); relayWS(clientConn, backendConn) }()
    go func() { defer wg.Done(); relayWS(backendConn, clientConn) }()
    wg.Wait()
}

func relayWS(src, dst *websocket.Conn) {
    for {
        msgType, msg, err := src.ReadMessage()
        if err != nil { break }
        if err := dst.WriteMessage(msgType, msg); err != nil { break }
    }
    dst.WriteMessage(websocket.CloseMessage,
        websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
}
```

### 5.2 修改文件

#### `internal/model/config.go`

Config struct 增加：
```go
Proxy ProxyConfig `yaml:"proxy"`
```

#### `internal/handler/handler.go`

RegisterRoutes 新增路由：
```go
register("/api/proxy/ports", middleware.Auth(ServeProxyPorts))
register("/api/proxy/ports/", middleware.Auth(ServeProxyPortRegister))  // POST + DELETE
register("/api/proxy/detect", middleware.Auth(ServeProxyDetect))
register("/api/proxy/forward/", middleware.Auth(ServeProxyForward))
register("/api/proxy/ws/", middleware.Auth(ServeProxyWebSocket))
```

**注意**：Go 1.21 `ServeMux` 的 `/api/proxy/ports/` 匹配所有以此前缀开头的路径。POST `/api/proxy/ports` 创建端口，DELETE `/api/proxy/ports/5173` 删除端口。handler 内通过 `r.Method` 和 `r.URL.Path` 手动路由。

#### `cmd/server/main.go`

在 scheduler 初始化之后：
```go
// Initialize proxy service
proxyService := service.NewProxyRegistry(cfg.Proxy, port)
service.ProxyService = proxyService
defer proxyService.Stop()
```

设置 `model.ProxyAllowedPorts` 从 config。

#### `config.example.yaml`

新增：
```yaml
# 端口转发配置（Android WebView 访问服务器本地端口）
proxy:
  enabled: true                # 启用端口转发代理
  allowed_ports: "1024-65535"  # 允许转发的端口范围
```

### 5.3 新增依赖

```bash
go get github.com/gorilla/websocket@latest
```

---

## 6. Android 端设计

### 6.1 修改 `MainActivity.java`

#### 新增字段

```java
final Set<Integer> forwardedPorts = ConcurrentHashMap.newKeySet();
```

#### 新增 import

```java
import android.util.Log;
import android.webkit.WebResourceResponse;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import org.json.JSONArray;
```

#### `ClawBenchWebViewClient` 新增 `shouldInterceptRequest`

```java
@Override
public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
    Uri url = request.getUrl();
    String host = url.getHost();
    String scheme = url.getScheme();

    // 只拦截 http://localhost:{port} 或 http://127.0.0.1:{port} 的已注册端口
    if (("localhost".equals(host) || "127.0.0.1".equals(host))
            && "http".equals(scheme)) {
        int port = url.getPort();
        if (port > 0 && forwardedPorts.contains(port)) {
            return proxyRequest(request, port);
        }
    }
    return super.shouldInterceptRequest(view, request);
}
```

#### 新增 `proxyRequest` 方法

```java
private WebResourceResponse proxyRequest(WebResourceRequest originalRequest, int port) {
    try {
        String serverUrl = prefs.getString(KEY_SERVER_URL, "");
        String path = originalRequest.getUrl().getPath();
        String query = originalRequest.getUrl().getQuery();
        String targetUrl = serverUrl + "/api/proxy/forward/" + port + path;
        if (query != null && !query.isEmpty()) {
            targetUrl += "?" + query;
        }

        URL url = new URL(targetUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(originalRequest.getMethod());
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(30000);

        // 复制请求 header（排除 Host）
        Map<String, String> headers = originalRequest.getRequestHeaders();
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (!"Host".equalsIgnoreCase(entry.getKey())) {
                conn.setRequestProperty(entry.getKey(), entry.getValue());
            }
        }

        // 携带认证 cookie
        String cookie = CookieManager.getInstance().getCookie(serverUrl);
        if (cookie != null) {
            conn.setRequestProperty("Cookie", cookie);
        }

        int status = conn.getResponseCode();
        String contentType = conn.getContentType();
        String encoding = conn.getContentEncoding();
        if (contentType == null) contentType = "application/octet-stream";
        if (encoding == null) encoding = "utf-8";

        InputStream body = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();

        // 构造响应 header map
        Map<String, String> responseHeaders = new HashMap<>();
        for (Map.Entry<String, java.util.List<String>> entry : conn.getHeaderFields().entrySet()) {
            if (entry.getKey() != null) {
                responseHeaders.put(entry.getKey(), entry.getValue().get(0));
            }
        }

        String reasonPhrase = (status == 200) ? "OK" : "Error";
        return new WebResourceResponse(contentType, encoding, status, reasonPhrase,
                responseHeaders, body);
    } catch (Exception e) {
        Log.e("ClawBench", "Proxy request failed for port " + port, e);
        return null; // 回退到默认行为
    }
}
```

#### `WebAppInterface` 新增 JS Bridge 方法

```java
@JavascriptInterface
public void addForwardedPort(int port) {
    activity.runOnUiThread(() -> activity.forwardedPorts.add(port));
}

@JavascriptInterface
public void removeForwardedPort(int port) {
    activity.runOnUiThread(() -> activity.forwardedPorts.remove(port));
}

@JavascriptInterface
public String getForwardedPorts() {
    return new JSONArray(activity.forwardedPorts).toString();
}

@JavascriptInterface
public String getServerUrl() {
    return activity.prefs.getString(KEY_SERVER_URL, "");
}
```

#### 新增 `injectPortForwardInterception()` 方法

从 `onPageFinished` 调用，与 `injectChatStateMonitor` 并列。

注入的 JS 做三件事：

**1. 拦截 `fetch()`**：
```javascript
var originalFetch = window.fetch;
window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : input.url;
    try {
        var parsed = new URL(url, location.origin);
        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
            && parsed.protocol === 'http:') {
            var port = parsed.port || '80';
            var proxyUrl = serverUrl + '/api/proxy/forward/' + port
                + parsed.pathname + parsed.search;
            var newInput = (typeof input === 'string') ? proxyUrl : new Request(proxyUrl, input);
            return originalFetch.call(this, newInput, init);
        }
    } catch(e) {}
    return originalFetch.apply(this, arguments);
};
```

**2. 拦截 `XMLHttpRequest.open()`**：
```javascript
var origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url) {
    try {
        var parsed = new URL(url, location.origin);
        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
            && parsed.protocol === 'http:') {
            var port = parsed.port || '80';
            var proxyUrl = serverUrl + '/api/proxy/forward/' + port
                + parsed.pathname + parsed.search;
            return origOpen.apply(this, [method, proxyUrl].concat(
                Array.prototype.slice.call(arguments, 2)));
        }
    } catch(e) {}
    return origOpen.apply(this, arguments);
};
```

**3. 拦截 `WebSocket` 构造函数**：
```javascript
var OrigWebSocket = window.WebSocket;
window.WebSocket = function(url, protocols) {
    try {
        var parsed = new URL(url, location.origin);
        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
            && (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')) {
            var port = parsed.port || '80';
            var wsPath = parsed.pathname + parsed.search;
            var newUrl = serverUrl.replace(/^http/, 'ws')
                + '/api/proxy/ws/' + port + wsPath;
            return new OrigWebSocket(newUrl, protocols);
        }
    } catch(e) {}
    return new OrigWebSocket(url, protocols);
};
window.WebSocket.prototype = OrigWebSocket.prototype;
window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
window.WebSocket.OPEN = OrigWebSocket.OPEN;
window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
```

**4. 与已有 `injectChatStateMonitor` 的兼容**：

`injectChatStateMonitor` 已经 monkey-patch 了 `window.fetch` 和 `window.EventSource`。端口转发注入需要在聊天监控之后安装，并且要调用 `originalFetch` 而不是直接覆盖。最安全的方式：端口转发的 fetch 拦截包裹在 `injectChatStateMonitor` 之后安装，获取当前的 `window.fetch`（已经被聊天监控 patch 过的）作为自己的 `originalFetch`。

在 `onPageFinished` 中的调用顺序：
```java
@Override
public void onPageFinished(WebView view, String url) {
    super.onPageFinished(view, url);
    injectChatStateMonitor();       // 先安装聊天监控
    injectPortForwardInterception(); // 再安装端口转发（包裹上一步的 fetch）
}
```

---

## 7. 前端设计（Vue 3 + TypeScript）

### 7.1 新建文件

#### `web/src/composables/useAppMode.ts`

模块级单例（同 `useAutoSpeech` 模式）：

```typescript
import { ref } from 'vue'

const isAppMode = ref(false)
let initialized = false

export function useAppMode() {
    if (!initialized) {
        initialized = true
        try {
            if (typeof (window as any).AndroidNative !== 'undefined') {
                isAppMode.value = (window as any).AndroidNative.isNativeApp() === true
            }
            // 备用：检测 User-Agent
            if (!isAppMode.value && navigator.userAgent.includes('ClawBench-Android')) {
                isAppMode.value = true
            }
        } catch {}
    }
    return { isAppMode }
}
```

#### `web/src/composables/usePortForward.ts`

```typescript
import { ref } from 'vue'
import { apiGet, apiPost, apiDelete } from '@/utils/api.ts'
import { useAppMode } from './useAppMode.ts'

interface ForwardedPort {
    port: number; name: string; autoDetect: boolean; active: boolean
}

const ports = ref<ForwardedPort[]>([])
const detectedPorts = ref<number[]>([])
const loading = ref(false)

export function usePortForward() {
    const { isAppMode } = useAppMode()

    async function loadPorts() {
        loading.value = true
        try {
            const data = await apiGet<{ ports: ForwardedPort[] }>('/api/proxy/ports')
            ports.value = data.ports || []
        } finally {
            loading.value = false
        }
    }

    async function registerPort(port: number, name?: string) {
        await apiPost('/api/proxy/ports', { port, name: name || '' })
        if (isAppMode.value) {
            (window as any).AndroidNative?.addForwardedPort(port)
        }
        await loadPorts()
    }

    async function unregisterPort(port: number) {
        await apiDelete(`/api/proxy/ports/${port}`)
        if (isAppMode.value) {
            (window as any).AndroidNative?.removeForwardedPort(port)
        }
        await loadPorts()
    }

    async function detectPorts() {
        const data = await apiGet<{ ports: number[] }>('/api/proxy/detect')
        detectedPorts.value = data.ports || []
    }

    // 首次加载时同步所有已注册端口到 Android
    async function syncToNative() {
        if (!isAppMode.value) return
        await loadPorts()
        for (const p of ports.value) {
            (window as any).AndroidNative?.addForwardedPort(p.port)
        }
    }

    return { ports, detectedPorts, loading, isAppMode,
             loadPorts, registerPort, unregisterPort, detectPorts, syncToNative }
}
```

#### `web/src/components/proxy/ProxyPortItem.vue`

紧凑行组件，样式参考 `TaskDrawer.vue` 的 `.task-item`：

- 端口号（大字，等宽 font-family: monospace）
- 名称描述
- 状态灯（CSS 绿/灰圆点）
- "打开"按钮：`window.open('http://localhost:' + port, '_blank')`（触发 shouldInterceptRequest）
- "删除"按钮：调用 `unregisterPort`

Props: `{ port: number, name: string, active: boolean }`
Emits: `open(port)`, `remove(port)`

#### `web/src/components/proxy/ProxyPanel.vue`

`BottomSheet` compact 模式（同 `TaskDrawer`），包含：

- 标题："端口转发" + 网络层 icon
- 端口列表（`ProxyPortItem`）
- "添加端口"按钮 → 内联输入框（端口号 + 名称），确认后调用 `registerPort`
- "自动检测"按钮 → 调用 `/api/proxy/detect`，检测结果以 chip 形式展示，点击 chip 即可注册
- 空状态："暂无转发端口"
- 仅 `isAppMode` 为 true 时渲染

Props: `{ open: Boolean }`
Emits: `close`

### 7.2 修改文件

#### `web/src/App.vue`

1. 导入 `useAppMode`, `usePortForward`, `ProxyPanel`
2. 新增 `const proxyOpen = ref(false)`
3. `drawerStates` 增加 `proxy: proxyOpen`
4. bottom dock 新增第 5 个按钮（仅 APP 模式显示）：

```html
<button v-if="isAppMode" class="dock-btn" :class="{ active: proxyOpen }"
        @click.stop="openDrawer('proxy')" title="端口转发">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
    </svg>
</button>
```

5. 模板中挂载 `ProxyPanel`：
```html
<ProxyPanel :open="proxyOpen" @close="proxyOpen = false" />
```

6. `onMounted` 中：如果 `isAppMode`，调用 `usePortForward().syncToNative()`

---

## 8. 安全考量

1. **认证**：所有 `/api/proxy/*` 路由走 `middleware.Auth`，未认证返回 401
2. **端口白名单**：只代理 `allowed_ports` 配置范围内的端口
3. **端口注册**：只代理已显式注册的端口，未注册返回 403
4. **仅 localhost**：Go 代理只连 `127.0.0.1:{port}`，不连内网其他 IP
5. **系统端口过滤**：自动检测忽略 < 1024 的端口
6. **Cookie 安全**：`SameSite=Strict` 防止跨站请求

---

## 9. 实施步骤

### Phase 1：Go 后端 — 端口注册 & CRUD API

| 步骤 | 文件 | 操作 | 依赖 |
|------|------|------|------|
| 1.1 | `internal/model/proxy.go` | 新建：ForwardedPort + ProxyConfig | 无 |
| 1.2 | `internal/service/proxy.go` | 新建：端口注册服务 | 1.1 |
| 1.3 | `internal/handler/proxy_api.go` | 新建：CRUD API | 1.2 |
| 1.4 | `internal/model/config.go` | 修改：增加 Proxy 配置段 | 1.1 |
| 1.5 | `internal/handler/handler.go` | 修改：注册 proxy 路由 | 1.3 |
| 1.6 | `cmd/server/main.go` | 修改：初始化 ProxyService | 1.2, 1.4 |
| 1.7 | `config.example.yaml` | 修改：新增 proxy 配置段 | 1.4 |

### Phase 2：Go 后端 — HTTP 反向代理 & WebSocket 中继

| 步骤 | 文件 | 操作 | 依赖 |
|------|------|------|------|
| 2.1 | `go.mod` | 修改：添加 gorilla/websocket | 无 |
| 2.2 | `internal/handler/proxy.go` | 新建：HTTP 代理 + WebSocket 中继 | 1.2, 2.1 |

### Phase 3：Android — shouldInterceptRequest & JS 注入

| 步骤 | 文件 | 操作 | 依赖 |
|------|------|------|------|
| 3.1 | `MainActivity.java` | 修改：新增 forwardedPorts 字段 + import | 无 |
| 3.2 | `MainActivity.java` | 修改：shouldInterceptRequest + proxyRequest | 3.1 |
| 3.3 | `MainActivity.java` | 修改：JS Bridge 新增方法 | 3.1 |
| 3.4 | `MainActivity.java` | 修改：injectPortForwardInterception | 3.2, 3.3 |

### Phase 4：前端 — APP 模式检测 & 端口转发 UI

| 步骤 | 文件 | 操作 | 依赖 |
|------|------|------|------|
| 4.1 | `web/src/composables/useAppMode.ts` | 新建 | 无 |
| 4.2 | `web/src/composables/usePortForward.ts` | 新建 | 4.1 |
| 4.3 | `web/src/components/proxy/ProxyPortItem.vue` | 新建 | 无 |
| 4.4 | `web/src/components/proxy/ProxyPanel.vue` | 新建 | 4.2, 4.3 |
| 4.5 | `web/src/App.vue` | 修改：dock 按钮 + ProxyPanel | 4.1, 4.4 |

### Phase 5：集成验证

```bash
go mod tidy && go build -o clawbench ./cmd/server && go test ./...
npm run build
```

---

## 10. 并行执行策略

```
可并行：
  Phase 1.1 (model) + Phase 3.1 (Android 字段) + Phase 4.1 (useAppMode) + Phase 4.3 (ProxyPortItem)

串行依赖链：
  Phase 1: 1.1 → 1.2 → 1.3 → 1.5,  1.1 → 1.4 → 1.6,  1.4 → 1.7
  Phase 2: 1.2 + 2.1 → 2.2
  Phase 3: 3.1 → (3.2 || 3.3) → 3.4
  Phase 4: 4.1 → 4.2,  4.2 + 4.3 → 4.4 → 4.5

Phase 1+2 和 Phase 3 完全独立，可以并行开发。
```

---

## 11. 文件清单

### 新建文件（8 个）

| # | 文件 | 说明 |
|---|------|------|
| 1 | `internal/model/proxy.go` | ForwardedPort 模型 + ProxyConfig |
| 2 | `internal/service/proxy.go` | 端口注册服务（注册表+健康检查+自动检测） |
| 3 | `internal/handler/proxy.go` | HTTP 反向代理 + WebSocket 中继 |
| 4 | `internal/handler/proxy_api.go` | 端口 CRUD API handlers |
| 5 | `web/src/composables/useAppMode.ts` | APP 模式检测 |
| 6 | `web/src/composables/usePortForward.ts` | 端口转发状态管理 |
| 7 | `web/src/components/proxy/ProxyPanel.vue` | 端口管理面板 |
| 8 | `web/src/components/proxy/ProxyPortItem.vue` | 单个端口条目 |

### 修改文件（6 个）

| # | 文件 | 修改内容 |
|---|------|---------|
| 1 | `internal/model/config.go` | 增加 `Proxy ProxyConfig` 字段 |
| 2 | `internal/handler/handler.go` | 注册 5 条 proxy 路由 |
| 3 | `cmd/server/main.go` | 初始化 ProxyService + 设置 ProxyAllowedPorts |
| 4 | `android/.../MainActivity.java` | shouldInterceptRequest + proxyRequest + JS Bridge + JS 注入 |
| 5 | `web/src/App.vue` | dock 按钮 + ProxyPanel 挂载 + drawerStates |
| 6 | `config.example.yaml` | 新增 proxy 配置段 |

### 新增依赖（1 个）

- `github.com/gorilla/websocket`

---

## 12. 已知限制 & 风险缓解

| 限制 | 缓解措施 |
|------|---------|
| `shouldInterceptRequest` 不暴露 POST body | JS 层 fetch/XHR 拦截重写 URL，POST body 由浏览器原生携带 |
| WebSocket 认证 | JS 注入构造的 WS URL 是同源的，浏览器自动携带 cookie |
| 流式响应性能 | 32KB buffer + http.Flusher，SSE 等流式协议即时 flush |
| fetch monkey-patch 冲突 | 端口转发注入在聊天监控之后，包裹上一步的 fetch，链式调用 |
| Android `HttpURLConnection` 无连接池 | 可接受——每次子资源请求独立连接，dev server 场景请求量不大 |
| HTTPS 服务器 + WS 代理 | `serverUrl.replace(/^http/, 'ws')` 正确处理 http→ws, https→wss |
