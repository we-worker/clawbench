package com.clawbench.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;

/**
 * Drop-in replacement for android.util.Log that also buffers entries and
 * periodically POSTs them to the ClawBench server's /api/android-log endpoint.
 *
 * Usage: replace Log.d(TAG, msg) with AppLog.d(TAG, msg) etc.
 *
 * When log capture is off (default), AppLog simply delegates to android.util.Log
 * with zero overhead. When capture is enabled via {@link #startCapture(String)},
 * entries are buffered in memory and flushed every 3 seconds (or when the buffer
 * reaches 200 entries) via HTTP POST.
 */
public class AppLog {

    private static final String TAG = "ClawBench-AppLog";
    private static final int BUFFER_CAPACITY = 500;
    private static final int FLUSH_THRESHOLD = 200;
    private static final long FLUSH_INTERVAL_MS = 3000;

    // Log entry buffer
    private static final List<LogEntry> buffer = new ArrayList<>();
    private static volatile boolean capturing = false;
    private static String serverBaseUrl = null;
    private static Handler flushHandler;
    private static Runnable flushRunnable;

    // SSL context that trusts all certs (for self-signed server certs)
    private static SSLContext trustAllSSL;

    static {
        try {
            trustAllSSL = SSLContext.getInstance("TLS");
            trustAllSSL.init(null, new javax.net.ssl.TrustManager[]{
                new javax.net.ssl.X509TrustManager() {
                    public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                    public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {}
                    public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {}
                }
            }, new java.security.SecureRandom());
        } catch (Exception e) {
            // Should never happen
        }
    }

    // --- Public API ---

    public static void d(String tag, String msg) { log('D', tag, msg); }
    public static void i(String tag, String msg) { log('I', tag, msg); }
    public static void w(String tag, String msg) { log('W', tag, msg); }
    public static void w(String tag, String msg, Throwable t) {
        log('W', tag, msg + "\n" + Log.getStackTraceString(t));
    }
    public static void e(String tag, String msg) { log('E', tag, msg); }
    public static void e(String tag, String msg, Throwable t) {
        log('E', tag, msg + "\n" + Log.getStackTraceString(t));
    }

    /**
     * Start capturing logs. Entries will be buffered and periodically flushed
     * to the server's /api/android-log endpoint.
     *
     * @param baseUrl the server base URL (e.g. "https://localhost:20000")
     */
    public static synchronized void startCapture(String baseUrl) {
        if (capturing) return;
        serverBaseUrl = baseUrl;
        capturing = true;
        flushHandler = new Handler(Looper.getMainLooper());
        flushRunnable = new Runnable() {
            @Override
            public void run() {
                if (!capturing) return;
                flushToServer();
                flushHandler.postDelayed(this, FLUSH_INTERVAL_MS);
            }
        };
        flushHandler.postDelayed(flushRunnable, FLUSH_INTERVAL_MS);
        i(TAG, "Log capture started");
    }

    /** Stop capturing and flush remaining entries. */
    public static synchronized void stopCapture() {
        if (!capturing) return;
        capturing = false;
        if (flushHandler != null) {
            flushHandler.removeCallbacks(flushRunnable);
            flushHandler = null;
        }
        flushToServer();
        i(TAG, "Log capture stopped");
        // The "stopped" entry itself won't be sent, but that's fine.
    }

    /** Returns whether log capture is currently active. */
    public static boolean isCapturing() {
        return capturing;
    }

    // --- Internal ---

    private static void log(char level, String tag, String msg) {
        // Always write to logcat
        switch (level) {
            case 'D': Log.d(tag, msg); break;
            case 'I': Log.i(tag, msg); break;
            case 'W': Log.w(tag, msg); break;
            case 'E': Log.e(tag, msg); break;
        }
        // Buffer if capturing
        if (capturing) {
            synchronized (buffer) {
                if (buffer.size() >= BUFFER_CAPACITY) {
                    buffer.remove(0); // drop oldest
                }
                buffer.add(new LogEntry(level, tag, msg, System.currentTimeMillis()));
                if (buffer.size() >= FLUSH_THRESHOLD) {
                    flushToServer();
                }
            }
        }
    }

    /** Flush all buffered entries to the server via HTTP POST. */
    static void flushToServer() {
        List<LogEntry> toSend;
        synchronized (buffer) {
            if (buffer.isEmpty()) return;
            toSend = new ArrayList<>(buffer);
            buffer.clear();
        }

        if (serverBaseUrl == null) return;

        // Build JSON payload
        try {
            JSONArray entries = new JSONArray();
            for (LogEntry e : toSend) {
                JSONObject obj = new JSONObject();
                obj.put("level", String.valueOf(e.level));
                obj.put("tag", e.tag);
                obj.put("msg", e.msg);
                obj.put("ts", e.ts);
                entries.put(obj);
            }
            JSONObject payload = new JSONObject();
            payload.put("entries", entries);

            // POST in background thread
            new Thread(() -> {
                try {
                    postLogPayload(payload.toString());
                } catch (Exception ignored) {
                    // Log delivery is best-effort; don't crash the app
                }
            }).start();
        } catch (Exception ignored) {
            // JSON building should never fail, but just in case
        }
    }

    private static void postLogPayload(String json) throws Exception {
        String urlStr = serverBaseUrl + "/api/android-log";
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);

            // Trust self-signed certs for HTTPS connections
            if (conn instanceof HttpsURLConnection) {
                ((HttpsURLConnection) conn).setSSLSocketFactory(trustAllSSL.getSocketFactory());
                ((HttpsURLConnection) conn).setHostnameVerifier((hostname, session) -> true);
            }

            // Write request body
            byte[] data = json.getBytes("UTF-8");
            conn.setFixedLengthStreamingMode(data.length);
            OutputStream os = conn.getOutputStream();
            os.write(data);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            if (code != 200) {
                // Best-effort; log the failure to logcat only
                Log.w(TAG, "Failed to post android logs: HTTP " + code);
            }
        } finally {
            conn.disconnect();
        }
    }

    // --- Data class ---

    private static class LogEntry {
        final char level;
        final String tag;
        final String msg;
        final long ts; // epoch millis

        LogEntry(char level, String tag, String msg, long ts) {
            this.level = level;
            this.tag = tag;
            this.msg = msg;
            this.ts = ts;
        }
    }
}
