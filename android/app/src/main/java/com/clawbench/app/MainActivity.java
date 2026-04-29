package com.clawbench.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONArray;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Main Activity: hosts a fullscreen WebView that connects to the ClawBench server.
 *
 * Key features:
 * - Server URL configuration dialog on first launch
 * - WebView with JS, DOM storage, and media autoplay enabled
 * - JavaScript interface for native bridge (keep-alive service control, port forwarding)
 * - Port forwarding via shouldInterceptRequest for transparent localhost proxying
 * - Proper back navigation within WebView
 * - SSL error handling with user confirmation
 */
public class MainActivity extends Activity {

    private static final String PREFS_NAME = "clawbench_prefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final String CHANNEL_ID = "clawbench_chat";
    private static final String TAG = "ClawBench";

    private WebView webView;
    private ProgressBar progressBar;
    private SharedPreferences prefs;

    // Set of ports currently being forwarded (thread-safe for access from WebView background threads)
    final Set<Integer> forwardedPorts = ConcurrentHashMap.newKeySet();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen on while app is in foreground (AI may take time to respond)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        createNotificationChannel();
        setupWebView();

        // Load saved URL or show configuration dialog
        String savedUrl = prefs.getString(KEY_SERVER_URL, null);
        if (savedUrl != null) {
            loadUrl(savedUrl);
        } else {
            showServerDialog();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();

        // Core web features
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Critical: allow audio.play() without user gesture (enables TTS in lock screen)
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Allow mixed content (HTTP API calls from HTTPS page, or vice versa)
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // File access for uploads
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        // Responsive layout
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // Enable smooth scrolling
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        // Set custom user agent
        String ua = settings.getUserAgentString();
        settings.setUserAgentString(ua + " ClawBench-Android/1.0");

        // JavaScript interface for native bridge
        webView.addJavascriptInterface(new WebAppInterface(this), "AndroidNative");

        // WebView client for navigation and error handling
        webView.setWebViewClient(new ClawBenchWebViewClient());

        // Chrome client for progress and file chooser
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, android.webkit.ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                // TODO: handle file chooser for uploads
                return false;
            }
        });

        // Enable cookies (needed for auth session)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
    }

    private void loadUrl(String url) {
        if (isNetworkAvailable()) {
            webView.loadUrl(url);
        } else {
            Toast.makeText(this, R.string.error_connection_failed, Toast.LENGTH_LONG).show();
        }
    }

    @SuppressWarnings("deprecation")
    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        NetworkInfo ni = cm.getActiveNetworkInfo();
        return ni != null && ni.isConnected();
    }

    /**
     * Show dialog for user to input ClawBench server URL.
     * Called on first launch or when user wants to change server.
     */
    private void showServerDialog() {
        View dialogView = getLayoutInflater().inflate(R.layout.dialog_server_url, null);
        EditText input = dialogView.findViewById(R.id.serverUrlInput);

        // Pre-fill with saved URL if exists
        String savedUrl = prefs.getString(KEY_SERVER_URL, "");
        input.setText(savedUrl);
        input.setSelection(input.getText().length());

        new AlertDialog.Builder(this)
                .setTitle(R.string.dialog_title)
                .setView(dialogView)
                .setPositiveButton(R.string.dialog_positive, (dialog, which) -> {
                    String url = input.getText().toString().trim();
                    if (url.isEmpty()) {
                        Toast.makeText(this, R.string.error_no_url, Toast.LENGTH_SHORT).show();
                        showServerDialog();
                        return;
                    }
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        Toast.makeText(this, R.string.error_invalid_url, Toast.LENGTH_SHORT).show();
                        showServerDialog();
                        return;
                    }
                    // Remove trailing slash
                    if (url.endsWith("/")) {
                        url = url.substring(0, url.length() - 1);
                    }
                    prefs.edit().putString(KEY_SERVER_URL, url).apply();
                    loadUrl(url);
                })
                .setNegativeButton(R.string.dialog_negative, null)
                .setCancelable(false)
                .show();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.notification_channel_name),
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(getString(R.string.notification_channel_desc));
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        ChatKeepAliveService.stop(this);
        super.onDestroy();
    }

    // --- WebView Client ---

    private class ClawBenchWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost();

            // Allow localhost and the configured server
            String serverUrl = prefs.getString(KEY_SERVER_URL, "");
            String serverHost = Uri.parse(serverUrl).getHost();

            if ("localhost".equals(host) || "127.0.0.1".equals(host) || host.equals(serverHost)) {
                return false; // Load in WebView
            }

            // Open external links in system browser
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            startActivity(intent);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String host = url.getHost();
            String scheme = url.getScheme();

            // Intercept http://localhost:{port} or http://127.0.0.1:{port} for registered forwarded ports
            if (("localhost".equals(host) || "127.0.0.1".equals(host))
                    && "http".equals(scheme)) {
                int port = url.getPort();
                if (port > 0 && forwardedPorts.contains(port)) {
                    return proxyRequest(request, port);
                }
            }

            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            String serverUrl = prefs.getString(KEY_SERVER_URL, "");
            if (serverUrl.startsWith("https://")) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("SSL \u8bc1\u4e66\u9a8c\u8bc1\u5931\u8d25")
                        .setMessage("\u670d\u52a1\u5668\u4f7f\u7528\u81ea\u7b7e\u540d\u8bc1\u4e66\uff0c\u662f\u5426\u4fe1\u4efb\u8be5\u8bc1\u4e66\uff1f\n\n" + error.toString())
                        .setPositiveButton("\u4fe1\u4efb\u5e76\u7ee7\u7eed", (dialog, which) -> handler.proceed())
                        .setNegativeButton("\u53d6\u6d88", (dialog, which) -> handler.cancel())
                        .setCancelable(false)
                        .show();
            } else {
                handler.cancel();
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            injectChatStateMonitor();
            injectPortForwardInterception();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                Toast.makeText(MainActivity.this, R.string.error_connection_failed, Toast.LENGTH_SHORT).show();
            }
        }
    }

    // --- Port Forwarding: HTTP Proxy ---

    /**
     * Proxies a WebView request through the ClawBench server's /api/proxy/forward endpoint.
     * Called from shouldInterceptRequest on a background thread.
     */
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

            // Copy request headers (exclude Host)
            Map<String, String> headers = originalRequest.getRequestHeaders();
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (!"Host".equalsIgnoreCase(entry.getKey())) {
                    conn.setRequestProperty(entry.getKey(), entry.getValue());
                }
            }

            // Add auth cookie from WebView
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

            // Build response headers map
            Map<String, String> responseHeaders = new HashMap<>();
            for (Map.Entry<String, java.util.List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() != null && !entry.getValue().isEmpty()) {
                    responseHeaders.put(entry.getKey(), entry.getValue().get(0));
                }
            }

            String reasonPhrase = (status == 200) ? "OK" : "Error";
            return new WebResourceResponse(contentType, encoding, status, reasonPhrase,
                    responseHeaders, body);
        } catch (Exception e) {
            Log.e(TAG, "Proxy request failed for port " + port, e);
            return null; // Fallback to default behavior
        }
    }

    // --- JavaScript Injection ---

    /**
     * Inject JavaScript that monitors the ClawBench chat state.
     * - Intercepts fetch POST to /api/ai/chat -> starts keep-alive
     * - Intercepts EventSource SSE done/cancelled -> stops keep-alive
     */
    private void injectChatStateMonitor() {
        String js =
            "(function() {" +
            "  if (window.__clawbenchMonitorInstalled) return;" +
            "  window.__clawbenchMonitorInstalled = true;" +
            "" +
            "  // Intercept fetch to detect chat messages being sent" +
            "  var originalFetch = window.fetch;" +
            "  window.fetch = function() {" +
            "    var url = arguments[0];" +
            "    if (typeof url === 'string' && url.indexOf('/api/ai/chat') !== -1 && url.indexOf('/stream') === -1) {" +
            "      if (typeof AndroidNative !== 'undefined') AndroidNative.startKeepAlive();" +
            "    }" +
            "    return originalFetch.apply(this, arguments);" +
            "  };" +
            "" +
            "  // Intercept EventSource to detect SSE connection events" +
            "  var OrigES = window.EventSource;" +
            "  window.EventSource = function(url, config) {" +
            "    var es = new OrigES(url, config);" +
            "    if (typeof url === 'string' && url.indexOf('/api/ai/chat/stream') !== -1) {" +
            "      es.addEventListener('done', function() {" +
            "        setTimeout(function() {" +
            "          if (typeof AndroidNative !== 'undefined') AndroidNative.stopKeepAlive();" +
            "        }, 2000);" +
            "      });" +
            "      es.addEventListener('cancelled', function() {" +
            "        if (typeof AndroidNative !== 'undefined') AndroidNative.stopKeepAlive();" +
            "      });" +
            "    }" +
            "    return es;" +
            "  };" +
            "  window.EventSource.prototype = OrigES.prototype;" +
            "  window.EventSource.CONNECTING = OrigES.CONNECTING;" +
            "  window.EventSource.OPEN = OrigES.OPEN;" +
            "  window.EventSource.CLOSED = OrigES.CLOSED;" +
            "})();";

        webView.evaluateJavascript(js, null);
    }

    /**
     * Inject JavaScript for port forwarding: intercepts fetch(), XHR, and WebSocket
     * calls to localhost:{port} and rewrites URLs to go through the server proxy.
     *
     * This is installed AFTER injectChatStateMonitor, so it wraps the already-patched fetch.
     * shouldInterceptRequest handles GET subresource loads (scripts, CSS, images);
     * this JS handles JS-initiated requests (fetch/XHR with POST bodies) and WebSocket.
     */
    private void injectPortForwardInterception() {
        String js =
            "(function() {" +
            "  if (window.__clawbenchProxyInstalled) return;" +
            "  window.__clawbenchProxyInstalled = true;" +
            "" +
            "  var serverUrl = '';" +
            "  try { serverUrl = AndroidNative.getServerUrl(); } catch(e) {}" +
            "  if (!serverUrl) return;" +
            "" +
            "  // Intercept fetch() for localhost URLs (handles POST bodies)" +
            "  var currentFetch = window.fetch;" +
            "  window.fetch = function(input, init) {" +
            "    try {" +
            "      var url = (typeof input === 'string') ? input : (input && input.url ? input.url : '');" +
            "      if (url) {" +
            "        var parsed = new URL(url, location.origin);" +
            "        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.protocol === 'http:') {" +
            "          var port = parsed.port || '80';" +
            "          var proxyUrl = serverUrl + '/api/proxy/forward/' + port + parsed.pathname + parsed.search;" +
            "          if (typeof input === 'string') {" +
            "            input = proxyUrl;" +
            "          } else if (input instanceof Request) {" +
            "            input = new Request(proxyUrl, input);" +
            "          }" +
            "          return currentFetch.call(this, input, init);" +
            "        }" +
            "      }" +
            "    } catch(e) {}" +
            "    return currentFetch.apply(this, arguments);" +
            "  };" +
            "" +
            "  // Intercept XMLHttpRequest.open() for localhost URLs" +
            "  var origOpen = XMLHttpRequest.prototype.open;" +
            "  XMLHttpRequest.prototype.open = function(method, url) {" +
            "    try {" +
            "      if (typeof url === 'string') {" +
            "        var parsed = new URL(url, location.origin);" +
            "        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && parsed.protocol === 'http:') {" +
            "          var port = parsed.port || '80';" +
            "          var proxyUrl = serverUrl + '/api/proxy/forward/' + port + parsed.pathname + parsed.search;" +
            "          return origOpen.apply(this, [method, proxyUrl].concat(Array.prototype.slice.call(arguments, 2)));" +
            "        }" +
            "      }" +
            "    } catch(e) {}" +
            "    return origOpen.apply(this, arguments);" +
            "  };" +
            "" +
            "  // Intercept WebSocket constructor for localhost URLs" +
            "  var OrigWebSocket = window.WebSocket;" +
            "  window.WebSocket = function(url, protocols) {" +
            "    try {" +
            "      if (typeof url === 'string') {" +
            "        var parsed = new URL(url, location.origin);" +
            "        if ((parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')" +
            "            && (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')) {" +
            "          var port = parsed.port || '80';" +
            "          var wsPath = parsed.pathname + parsed.search;" +
            "          var newUrl = serverUrl.replace(/^http/, 'ws') + '/api/proxy/ws/' + port + wsPath;" +
            "          return new OrigWebSocket(newUrl, protocols);" +
            "        }" +
            "      }" +
            "    } catch(e) {}" +
            "    return new OrigWebSocket(url, protocols);" +
            "  };" +
            "  window.WebSocket.prototype = OrigWebSocket.prototype;" +
            "  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;" +
            "  window.WebSocket.OPEN = OrigWebSocket.OPEN;" +
            "  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;" +
            "})();";

        webView.evaluateJavascript(js, null);
    }

    // --- JavaScript Interface ---

    public static class WebAppInterface {
        private final MainActivity activity;

        public WebAppInterface(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public void startKeepAlive() {
            activity.runOnUiThread(() -> ChatKeepAliveService.start(activity));
        }

        @JavascriptInterface
        public void stopKeepAlive() {
            activity.runOnUiThread(() -> ChatKeepAliveService.stop(activity));
        }

        @JavascriptInterface
        public String getAppVersion() {
            try {
                return activity.getPackageManager()
                        .getPackageInfo(activity.getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "1.0.0";
            }
        }

        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

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
    }
}
