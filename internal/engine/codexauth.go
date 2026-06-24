package engine

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// codexAuth holds the credential a Codex (ChatGPT-subscription) request needs.
type codexAuth struct {
	accessToken string
	accountID   string
}

// codexAuthFile mirrors the relevant fields of ~/.codex/auth.json, the file the
// Codex CLI writes after an OAuth login. We never write it — only read it, and
// re-read on every step so a background `codex` token refresh is picked up.
type codexAuthFile struct {
	OpenAIAPIKey *string `json:"OPENAI_API_KEY"`
	Tokens       struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		AccountID    string `json:"account_id"`
	} `json:"tokens"`
}

// codexAuthPath is the credential file location (overridable for tests).
var codexAuthPath = func() string {
	if v := os.Getenv("CODEX_HOME"); v != "" {
		return filepath.Join(v, "auth.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "auth.json")
}

// loadCodexAuth reads the Codex credential and verifies the access token has not
// expired (the JWT's `exp` claim). It is read fresh each call so a background
// `codex` refresh is honored. On expiry it returns a clear, actionable error
// rather than attempting an OAuth refresh (whose client_id we will not invent).
func loadCodexAuth() (codexAuth, error) {
	raw, err := os.ReadFile(codexAuthPath())
	if err != nil {
		return codexAuth{}, fmt.Errorf("codex auth: read %s: %w (run `codex login`)", codexAuthPath(), err)
	}
	var f codexAuthFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return codexAuth{}, fmt.Errorf("codex auth: parse: %w", err)
	}
	tok := f.Tokens.AccessToken
	if tok == "" {
		return codexAuth{}, fmt.Errorf("codex auth: no access token in %s (run `codex login`)", codexAuthPath())
	}
	if exp, ok := jwtExpiry(tok); ok && time.Now().After(exp) {
		return codexAuth{}, fmt.Errorf("codex auth: access token expired at %s — run `codex` to refresh it", exp.Format(time.RFC3339))
	}
	return codexAuth{accessToken: tok, accountID: f.Tokens.AccountID}, nil
}

// jwtExpiry extracts the `exp` (unix seconds) from a JWT's payload without
// verifying the signature — the server verifies it; we only avoid sending a
// token we already know is stale. Returns ok=false if exp can't be read.
func jwtExpiry(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

// CodexAuthAvailable reports whether a usable (non-expired) Codex credential is
// present, so the runtime can auto-select the engine for local dev.
func CodexAuthAvailable() bool {
	_, err := loadCodexAuth()
	return err == nil
}
