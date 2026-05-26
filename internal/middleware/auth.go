package middleware

import (
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"net/url"

	"clawbench/internal/model"
)

// IsLocalhost returns true if the request originates from the local machine.
// Used for non-auth purposes (e.g. RAG CLI global search without project).
// NOTE: This does NOT bypass Auth middleware — all requests need a valid cookie.
func IsLocalhost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return host == "127.0.0.1" || host == "::1" || host == "localhost"
}

// Auth wraps a handler with password auth if configured.
// All requests (including localhost) require a valid "clawbench_session" cookie.
func Auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// No password configured — open access
		if model.SessionToken == "" {
			next.ServeHTTP(w, r)
			return
		}
		// Cookie-based auth
		token, err := r.Cookie(model.SessionCookie)
		if err == nil && token != nil && subtle.ConstantTimeCompare([]byte(token.Value), []byte(model.SessionToken)) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		slog.Warn("auth: rejecting request", "path", r.URL.Path, "remote", r.RemoteAddr, "has_cookie", err == nil)
		model.WriteError(w, model.Unauthorized(nil))
	}
}

// GetProjectFromCookie extracts the current project path from cookie.
func GetProjectFromCookie(r *http.Request) string {
	cookie, err := r.Cookie("clawbench_project")
	if err != nil || cookie == nil || cookie.Value == "" {
		return ""
	}
	decoded, decErr := url.QueryUnescape(cookie.Value)
	if decErr != nil {
		return cookie.Value
	}
	return decoded
}
