package model

import (
	"crypto/sha256"
	"encoding/hex"
)

const sessionSalt = "clawbench-salt"

// SessionTokenForPassword derives the session cookie value from the configured password.
func SessionTokenForPassword(password string) string {
	hash := sha256.Sum256([]byte(password + sessionSalt))
	return hex.EncodeToString(hash[:])
}
