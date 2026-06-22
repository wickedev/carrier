package skill

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wickedev/carrier/internal/tool"
)

// writeSkill creates scope/<dir>/SKILL.md with the given contents.
func writeSkill(t *testing.T, scope, dir, contents string) string {
	t.Helper()
	d := filepath.Join(scope, dir)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", d, err)
	}
	p := filepath.Join(d, "SKILL.md")
	if err := os.WriteFile(p, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

const alphaSKILL = `---
name: alpha
description: The alpha skill does alpha things.
allowed-tools: [read, write]
---

# Alpha

This is the alpha body. ALPHA_BODY_MARKER
`

const betaSKILL = `---
name: beta
description: The beta skill is restricted.
agent: reviewer
---

Beta body. BETA_BODY_MARKER
`

func TestDiscover(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "alpha", alphaSKILL)
	writeSkill(t, scope, "beta", betaSKILL)
	// A subdir without SKILL.md must be ignored.
	if err := os.MkdirAll(filepath.Join(scope, "notaskill"), 0o755); err != nil {
		t.Fatal(err)
	}

	skills, err := Discover(scope)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("got %d skills, want 2: %+v", len(skills), skills)
	}

	// Sorted by name → alpha, beta.
	a, b := skills[0], skills[1]
	if a.Name != "alpha" || b.Name != "beta" {
		t.Fatalf("names: got %q,%q want alpha,beta", a.Name, b.Name)
	}
	if a.Description != "The alpha skill does alpha things." {
		t.Errorf("alpha description: %q", a.Description)
	}
	if got := strings.Join(a.AllowedTools, ","); got != "read,write" {
		t.Errorf("alpha allowed-tools: %q", got)
	}
	if a.AgentRestriction != "" {
		t.Errorf("alpha should have no agent restriction, got %q", a.AgentRestriction)
	}
	if b.AgentRestriction != "reviewer" {
		t.Errorf("beta agent restriction: %q", b.AgentRestriction)
	}
	if !strings.HasSuffix(a.Path, filepath.Join("alpha", "SKILL.md")) {
		t.Errorf("alpha path: %q", a.Path)
	}
}

func TestDiscoverLazyBody(t *testing.T) {
	scope := t.TempDir()
	p := writeSkill(t, scope, "alpha", alphaSKILL)

	skills, err := Discover(scope)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("want 1 skill, got %d", len(skills))
	}

	// Prove the body is lazy: removing the file before calling Body() makes the
	// read fail, which is only possible if discovery did not pre-read it.
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if _, err := skills[0].Body(); err == nil {
		t.Fatal("expected Body() to fail after file removal (proving laziness)")
	}
}

func TestDiscoverBodyContent(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "alpha", alphaSKILL)
	skills, err := Discover(scope)
	if err != nil {
		t.Fatal(err)
	}
	body, err := skills[0].Body()
	if err != nil {
		t.Fatalf("Body: %v", err)
	}
	if !strings.Contains(body, "ALPHA_BODY_MARKER") {
		t.Errorf("body missing marker: %q", body)
	}
	if strings.Contains(body, "name: alpha") {
		t.Errorf("body should not include frontmatter: %q", body)
	}
}

func TestDiscoverMissingScopeSkipped(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "alpha", alphaSKILL)
	missing := filepath.Join(scope, "does-not-exist")

	skills, err := Discover(missing, scope)
	if err != nil {
		t.Fatalf("Discover with missing scope should not error: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("want 1 skill, got %d", len(skills))
	}
}

func TestGatewayReturnsBody(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "alpha", alphaSKILL)
	skills, err := Discover(scope)
	if err != nil {
		t.Fatal(err)
	}
	g := NewGateway(skills, "")

	// Interface conformance.
	var _ tool.Tool = g
	if g.Name() != GatewayName {
		t.Errorf("gateway name: %q", g.Name())
	}

	res, err := g.Exec(context.Background(), map[string]any{"name": "alpha"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %q", res.Content)
	}
	if !strings.Contains(res.Content, "ALPHA_BODY_MARKER") {
		t.Errorf("result missing body: %q", res.Content)
	}
}

func TestGatewayUnknownSkill(t *testing.T) {
	g := NewGateway(nil, "")
	res, err := g.Exec(context.Background(), map[string]any{"name": "nope"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec returned hard error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error result for unknown skill")
	}
	if !strings.Contains(res.Content, "unknown skill") {
		t.Errorf("error content: %q", res.Content)
	}
}

func TestGatewayMissingName(t *testing.T) {
	g := NewGateway(nil, "")
	res, _ := g.Exec(context.Background(), map[string]any{}, tool.ExecContext{})
	if !res.IsError {
		t.Fatal("expected error result for missing name")
	}
}

func TestGatewayAgentRestriction(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "beta", betaSKILL)
	skills, err := Discover(scope)
	if err != nil {
		t.Fatal(err)
	}

	// Wrong agent → refused.
	g := NewGateway(skills, "coder")
	res, err := g.Exec(context.Background(), map[string]any{"name": "beta"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected restriction error, got body: %q", res.Content)
	}
	if !strings.Contains(res.Content, "restricted") {
		t.Errorf("error content: %q", res.Content)
	}

	// Matching agent → body returned.
	g2 := NewGateway(skills, "reviewer")
	res2, err := g2.Exec(context.Background(), map[string]any{"name": "beta"}, tool.ExecContext{})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if res2.IsError {
		t.Fatalf("matching agent should succeed, got error: %q", res2.Content)
	}
	if !strings.Contains(res2.Content, "BETA_BODY_MARKER") {
		t.Errorf("result missing body: %q", res2.Content)
	}
}

func TestListingPrompt(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "alpha", alphaSKILL)
	writeSkill(t, scope, "beta", betaSKILL)
	skills, err := Discover(scope)
	if err != nil {
		t.Fatal(err)
	}

	prompt := ListingPrompt(skills)
	if !strings.Contains(prompt, "alpha") || !strings.Contains(prompt, "beta") {
		t.Errorf("listing missing names: %q", prompt)
	}
	if !strings.Contains(prompt, "The alpha skill does alpha things.") {
		t.Errorf("listing missing description: %q", prompt)
	}
	// Bodies must NOT leak into the listing.
	if strings.Contains(prompt, "ALPHA_BODY_MARKER") || strings.Contains(prompt, "BETA_BODY_MARKER") {
		t.Errorf("listing leaked a body: %q", prompt)
	}

	if ListingPrompt(nil) != "" {
		t.Error("empty listing should be empty string")
	}
}

func TestListConflictFirstWins(t *testing.T) {
	scope := t.TempDir()
	writeSkill(t, scope, "alpha", alphaSKILL)
	skills, _ := Discover(scope)
	// Duplicate name → gateway keeps first.
	dup := skills[0]
	g := NewGateway([]Skill{skills[0], dup}, "")
	if len(g.Skills()) != 1 {
		t.Errorf("expected dedupe, got %d", len(g.Skills()))
	}
}
