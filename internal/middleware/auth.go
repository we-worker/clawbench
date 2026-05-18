package middleware

import (
	"crypto/subtle"
	"net/http"
	"net/url"

	"clawbench/internal/model"
)

// Auth wraps a handler with password auth if configured.
// When a password is configured, all requests require a valid "clawbench_session" cookie.
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
