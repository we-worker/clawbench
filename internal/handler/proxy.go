package handler

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/gorilla/websocket"

	"clawbench/internal/model"
	"clawbench/internal/service"
)

// Hop-by-hop headers that must not be forwarded (RFC 2616 Section 13.5.1).
var hopByHopHeaders = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"TE",
	"Trailers",
	"Transfer-Encoding",
	"Upgrade",
}

// isHopByHop returns true if the header name is a hop-by-hop header.
func isHopByHop(name string) bool {
	for _, h := range hopByHopHeaders {
		if strings.EqualFold(name, h) {
			return true
		}
	}
	return false
}

// ServeProxyForward handles HTTP reverse proxy requests.
// URL format: /api/proxy/forward/{port}/rest/of/path?query
func ServeProxyForward(w http.ResponseWriter, r *http.Request) {
	// 1. Parse port from URL path
	pathAfterPrefix := strings.TrimPrefix(r.URL.Path, "/api/proxy/forward/")
	parts := strings.SplitN(pathAfterPrefix, "/", 2)
	portStr := parts[0]
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		model.WriteErrorf(w, http.StatusBadRequest, fmt.Sprintf("Invalid port number: %s", portStr))
		return
	}

	// 2. Validate port is registered and allowed
	if service.ProxyService == nil || !service.ProxyService.IsPortAllowed(port) {
		model.WriteErrorf(w, http.StatusForbidden, fmt.Sprintf("Port %d is not allowed", port))
		return
	}
	if !service.ProxyService.IsPortRegistered(port) {
		model.WriteErrorf(w, http.StatusForbidden, fmt.Sprintf("Port %d is not registered", port))
		return
	}

	// 3. Construct target URL
	targetPath := "/"
	if len(parts) > 1 {
		targetPath += parts[1]
	}
	targetURL := fmt.Sprintf("http://127.0.0.1:%d%s", port, targetPath)
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	// 4. Create proxy request
	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		model.WriteErrorf(w, http.StatusInternalServerError, "Failed to create proxy request")
		return
	}

	// 5. Copy headers (filter hop-by-hop)
	for k, vv := range r.Header {
		if !isHopByHop(k) {
			for _, v := range vv {
				proxyReq.Header.Add(k, v)
			}
		}
	}
	proxyReq.Header.Set("X-Forwarded-For", r.RemoteAddr)
	proxyReq.Header.Set("X-Forwarded-Proto", "http")
	proxyReq.Host = fmt.Sprintf("127.0.0.1:%d", port)

	// 6. Execute proxy request
	resp, err := http.DefaultClient.Do(proxyReq)
	if err != nil {
		slog.Debug("proxy forward: backend unreachable",
			slog.Int("port", port),
			slog.String("target", targetURL),
			slog.String("err", err.Error()),
		)
		model.WriteErrorf(w, http.StatusBadGateway, fmt.Sprintf("Backend port %d unreachable", port))
		return
	}
	defer resp.Body.Close()

	// 7. Copy response headers (filter hop-by-hop)
	for k, vv := range resp.Header {
		if !isHopByHop(k) {
			for _, v := range vv {
				w.Header().Add(k, v)
			}
		}
	}

	// 8. Stream response body with flush support (critical for SSE)
	w.WriteHeader(resp.StatusCode)
	flusher, canFlush := w.(http.Flusher)

	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			break
		}
	}
}

// WebSocket upgrader — allows all origins (auth is handled by middleware)
var proxyWSUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

// ServeProxyWebSocket handles WebSocket relay between client and backend.
// URL format: /api/proxy/ws/{port}/rest/of/path?query
func ServeProxyWebSocket(w http.ResponseWriter, r *http.Request) {
	// 1. Parse port from URL path
	pathAfterPrefix := strings.TrimPrefix(r.URL.Path, "/api/proxy/ws/")
	parts := strings.SplitN(pathAfterPrefix, "/", 2)
	portStr := parts[0]
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		model.WriteErrorf(w, http.StatusBadRequest, fmt.Sprintf("Invalid port number: %s", portStr))
		return
	}

	// 2. Validate port
	if service.ProxyService == nil || !service.ProxyService.IsPortAllowed(port) {
		model.WriteErrorf(w, http.StatusForbidden, fmt.Sprintf("Port %d is not allowed", port))
		return
	}
	if !service.ProxyService.IsPortRegistered(port) {
		model.WriteErrorf(w, http.StatusForbidden, fmt.Sprintf("Port %d is not registered", port))
		return
	}

	// 3. Construct backend WebSocket URL
	targetPath := "/"
	if len(parts) > 1 {
		targetPath += parts[1]
	}
	targetURL := fmt.Sprintf("ws://127.0.0.1:%d%s", port, targetPath)
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	// 4. Dial backend WebSocket
	backendConn, _, err := websocket.DefaultDialer.Dial(targetURL, nil)
	if err != nil {
		slog.Debug("proxy ws: backend unreachable",
			slog.Int("port", port),
			slog.String("target", targetURL),
			slog.String("err", err.Error()),
		)
		model.WriteErrorf(w, http.StatusBadGateway, fmt.Sprintf("Backend WebSocket port %d unreachable", port))
		return
	}
	defer backendConn.Close()

	// 5. Upgrade client connection
	clientConn, err := proxyWSUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Debug("proxy ws: client upgrade failed", slog.String("err", err.Error()))
		return
	}
	defer clientConn.Close()

	// 6. Bidirectional relay
	var wg sync.WaitGroup
	wg.Add(2)

	// Client → Backend
	go func() {
		defer wg.Done()
		relayWS(clientConn, backendConn)
	}()

	// Backend → Client
	go func() {
		defer wg.Done()
		relayWS(backendConn, clientConn)
	}()

	wg.Wait()
}

// relayWS copies WebSocket messages from src to dst until an error occurs.
func relayWS(src, dst *websocket.Conn) {
	for {
		msgType, msg, err := src.ReadMessage()
		if err != nil {
			// Normal close or error — stop relaying
			break
		}
		if err := dst.WriteMessage(msgType, msg); err != nil {
			break
		}
	}
	// Signal close to the other direction
	dst.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
}

// copyBody streams from src to dst with flush support.
func copyBody(dst io.Writer, src io.Reader, flusher http.Flusher) {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			dst.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			break
		}
	}
}
