# Sandbox Browser for Port Forwarding

## Problem

When testing forwarded ports in the Android app, users currently open them in the device's external browser via `AndroidNative.openInBrowser()`. This leaves the app and shares cookies/session with the system browser — no isolation from the main ClawBench app's session state, making login/authentication testing unreliable.

The existing `PortForwardBrowser.vue` (iframe-based) is dead code and fundamentally cannot provide Cookie/Storage isolation because all frames in a WebView process share the same `CookieManager`.

## Solution

Create a `BrowserActivity` running in an **independent Android process** (`:browser`). This provides process-level isolation: separate `CookieManager`, `localStorage`, and session — zero sharing with the main app.

## Architecture

```
┌─────────────────────────────────────┐     ┌──────────────────────────────────┐
│  Main process (:default)            │     │  Sandbox process (:browser)      │
│                                     │     │                                  │
│  MainActivity                       │     │  BrowserActivity                 │
│  └─ WebView (ClawBench UI)          │     │  └─ WebView (test sandbox)       │
│     └─ CookieManager A             │     │     └─ CookieManager B           │
│     └─ localStorage A              │     │     └─ localStorage B            │
│     └─ Session A                   │     │     └─ Session B                 │
└─────────────────────────────────────┘     └──────────────────────────────────┘
       ↑                                              ↑
       │         Intent (port, protocol)               │
       └──────────────────────────────────────────────┘
```

## UI Design

```
┌─────────────────────────────────────────────┐
│  Safe area                                   │
│ ┌──────────────────────────────────────────┐ │
│ │ ← │ http://localhost:3000/dashboard │ ↻ │ 🗑 │ │  ← Toolbar
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ ProgressBar                              │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │                                          │ │
│ │           WebView content                │ │
│ │                                          │ │
│ └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Toolbar (4 elements)

| Element | Function | Details |
|---------|----------|---------|
| ← Back | WebView history back | Closes Activity when no history |
| URL bar | Display full URL, editable | Enter to navigate; localhost-only, external URLs go to system browser |
| ↻ Refresh | Reload current page | — |
| 🗑 Clear | Clear browsing data | Confirm dialog → removes cookies, storage, cache → refreshes page |

## Key Design Decisions

| Decision | Reason |
|----------|--------|
| `:browser` independent process | CookieManager is process-level singleton; separate process = full isolation |
| No `AndroidNative` bridge injection | Sandbox should simulate a real browser, no native capabilities exposed |
| URL restricted to localhost | Sandbox is for testing forwarded ports, not a general browser |
| Data persists across sessions | Users stay logged in for repeated testing |
| Manual clear data button | User controls when to reset to clean state |
| External URLs → system browser | Non-localhost links are handed to system, not loaded in sandbox |
| `taskAffinity=""` + `excludeFromRecents` | Sandbox doesn't appear in recent tasks, back button returns to main app |

## Implementation Steps

### Step 1: Delete iframe dead code

- Delete `web/src/components/proxy/PortForwardBrowser.vue`
- Clean `App.vue`: remove `PortForwardBrowser` component, `portForwardBrowserRef`, `setOpenPortBrowser` import
- Clean `usePortForward.ts`: remove `openPortBrowserFn`, `setOpenPortBrowser()`, `openPortBrowser` related code

### Step 2: Create BrowserActivity

New files:
- `android/app/src/main/java/com/clawbench/app/BrowserActivity.java`
- `android/app/src/main/res/layout/activity_browser.xml`
- `android/app/src/main/res/drawable/bg_url_bar.xml` (URL bar background)
- `android/app/src/main/res/drawable/ic_clear_data.xml` (clear data icon)

Layout: FrameLayout → LinearLayout (toolbar + ProgressBar + WebView)

### Step 3: Register BrowserActivity + bridge method

- `AndroidManifest.xml`: register `BrowserActivity` with `android:process=":browser"`, `android:taskAffinity=""`, `android:excludeFromRecents="true"`
- `MainActivity.java`: add `openInSandbox(int port, String protocol)` to `WebAppInterface`
- `res/values/themes.xml`: add browser activity theme

### Step 4: Frontend openPort change

`usePortForward.ts`: in app mode, call `openInSandbox` (with `openInBrowser` fallback)

### Step 5: i18n strings

Add browser toolbar translations (clear data confirmation dialog)

## Test Scenarios

| Scenario | Expected Result |
|----------|----------------|
| Main app logged in → open sandbox | Sandbox has no login state from main app |
| Sandbox login → close → reopen | Still logged in (cookies persist) |
| Tap clear data → confirm | Cookies/storage/cache cleared, page refreshes, logged out |
| Click external link in sandbox | Opens in system browser, not in sandbox |
| Navigate in sandbox → tap back | WebView history goes back |
| No history + tap back | Closes sandbox, returns to main app |
| Main app crashes | Sandbox unaffected (separate process) |
| Sandbox crashes | Main app unaffected (separate process) |
| Web mode open port | window.open() new tab (unchanged) |
