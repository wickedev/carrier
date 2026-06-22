// Package skill implements Carrier's Skills subsystem (Requirement 10):
// reusable instruction packages discovered from configured scopes, surfaced to
// the model as metadata only, with their bodies loaded on demand through a
// single gateway tool (progressive disclosure). A skill may declare an agent
// restriction and an allowed-tools list that the gateway enforces at invocation
// time.
package skill

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// skillFile is the conventional filename that marks a skill directory.
const skillFile = "SKILL.md"

// Skill is a discovered skill package. Metadata (Name, Description) is surfaced
// to the model up front; Body is loaded LAZILY (only when the gateway tool is
// invoked) so large instruction sets never occupy context until needed.
type Skill struct {
	Name        string
	Description string
	Path        string // absolute path to the SKILL.md file
	// Body lazily reads and returns the skill body (the markdown content after
	// the frontmatter). It is not evaluated at discovery time.
	Body             func() (string, error)
	AgentRestriction string   // empty → no restriction
	AllowedTools     []string // empty → no restriction
}

// Discover scans each scope directory for skills. A scope contains one level of
// subdirectories, each holding a SKILL.md file. Frontmatter is parsed eagerly
// for metadata; the body is captured behind a lazy closure. Discovery is
// best-effort per scope: a missing scope dir is skipped, but a malformed
// SKILL.md surfaces as an error.
func Discover(scopes ...string) ([]Skill, error) {
	var skills []Skill
	for _, scope := range scopes {
		entries, err := os.ReadDir(scope)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("skill: read scope %q: %w", scope, err)
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			path := filepath.Join(scope, e.Name(), skillFile)
			info, err := os.Stat(path)
			if err != nil || info.IsDir() {
				continue // subdir without a SKILL.md is not a skill
			}
			s, err := parseSkill(path)
			if err != nil {
				return nil, err
			}
			skills = append(skills, s)
		}
	}
	// Stable order keeps prompts cache-friendly.
	sort.Slice(skills, func(i, j int) bool { return skills[i].Name < skills[j].Name })
	return skills, nil
}

// parseSkill reads the frontmatter of a SKILL.md and returns a Skill whose Body
// is a lazy reader over the same file. The file's bytes are not read for the
// body until Body is called.
func parseSkill(path string) (Skill, error) {
	f, err := os.Open(path)
	if err != nil {
		return Skill{}, fmt.Errorf("skill: open %q: %w", path, err)
	}
	defer f.Close()

	fm, err := parseFrontmatter(f)
	if err != nil {
		return Skill{}, fmt.Errorf("skill: parse %q: %w", path, err)
	}
	name := fm.get("name")
	if name == "" {
		// Fall back to the containing directory name.
		name = filepath.Base(filepath.Dir(path))
	}
	s := Skill{
		Name:             name,
		Description:      fm.get("description"),
		Path:             path,
		AgentRestriction: fm.get("agent"),
		AllowedTools:     fm.getList("allowed-tools"),
		Body: func() (string, error) {
			return readBody(path)
		},
	}
	return s, nil
}

// readBody returns the markdown content of a SKILL.md following its frontmatter.
// If the file has no frontmatter delimiters, the whole file is the body.
func readBody(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("skill: read body %q: %w", path, err)
	}
	return bodyAfterFrontmatter(string(data)), nil
}

// frontmatter holds parsed key/value pairs from a SKILL.md header.
type frontmatter struct {
	scalars map[string]string
	lists   map[string][]string
}

func (f frontmatter) get(key string) string { return f.scalars[key] }

func (f frontmatter) getList(key string) []string {
	if v, ok := f.lists[key]; ok {
		return v
	}
	// A scalar value may stand in for a single-element list.
	if v, ok := f.scalars[key]; ok && v != "" {
		return []string{v}
	}
	return nil
}

// parseFrontmatter reads a leading `---`-delimited YAML-ish block and parses
// simple `key: value` and `key: [a, b]` lines. It is a deliberately small
// hand-rolled parser (stdlib only). A file without an opening `---` yields an
// empty frontmatter and no error.
func parseFrontmatter(r io.Reader) (frontmatter, error) {
	fm := frontmatter{scalars: map[string]string{}, lists: map[string][]string{}}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	// Find the opening delimiter, skipping leading blank lines.
	opened := false
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.TrimSpace(line) == "---" {
			opened = true
		}
		break
	}
	if !opened {
		return fm, nil // no frontmatter block
	}

	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "---" {
			break // closing delimiter
		}
		if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		key, val, ok := splitKeyValue(line)
		if !ok {
			continue // tolerate unexpected lines
		}
		if list, isList := parseList(val); isList {
			fm.lists[key] = list
		} else {
			fm.scalars[key] = unquote(val)
		}
	}
	if err := sc.Err(); err != nil {
		return fm, err
	}
	return fm, nil
}

// splitKeyValue splits "key: value" on the first colon.
func splitKeyValue(line string) (key, val string, ok bool) {
	i := strings.Index(line, ":")
	if i < 0 {
		return "", "", false
	}
	key = strings.TrimSpace(line[:i])
	val = strings.TrimSpace(line[i+1:])
	if key == "" {
		return "", "", false
	}
	return key, val, true
}

// parseList recognizes an inline `[a, b, c]` list and returns its elements.
func parseList(val string) ([]string, bool) {
	if !strings.HasPrefix(val, "[") || !strings.HasSuffix(val, "]") {
		return nil, false
	}
	inner := strings.TrimSpace(val[1 : len(val)-1])
	if inner == "" {
		return []string{}, true
	}
	parts := strings.Split(inner, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := unquote(strings.TrimSpace(p)); v != "" {
			out = append(out, v)
		}
	}
	return out, true
}

// unquote strips matching surrounding single or double quotes.
func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// bodyAfterFrontmatter returns the content following a leading `---`-delimited
// frontmatter block, or the whole string if no such block exists.
func bodyAfterFrontmatter(s string) string {
	lines := strings.Split(s, "\n")
	i := 0
	// Skip leading blank lines.
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i >= len(lines) || strings.TrimSpace(strings.TrimRight(lines[i], "\r")) != "---" {
		return strings.TrimSpace(s) // no frontmatter
	}
	i++ // past opening delimiter
	for i < len(lines) {
		if strings.TrimSpace(strings.TrimRight(lines[i], "\r")) == "---" {
			i++ // past closing delimiter
			break
		}
		i++
	}
	return strings.TrimSpace(strings.Join(lines[i:], "\n"))
}
