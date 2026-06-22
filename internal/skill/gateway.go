package skill

import (
	"context"
	"fmt"
	"strings"

	"github.com/wickedev/carrier/internal/tool"
)

// GatewayName is the registered name of the single skill gateway tool.
const GatewayName = "skill"

// Gateway is the single tool through which skill bodies are loaded on demand
// (Requirement 10.2). It surfaces only metadata to the model up front and
// returns a skill's body when invoked with {"name": "<skill-name>"}, after
// enforcing any per-skill agent restriction (Requirement 10.3/10.4).
//
// The current agent name used for restriction checks is carried on the Gateway
// itself rather than on tool.ExecContext, keeping the tool contract unchanged.
type Gateway struct {
	tool.Base
	skills map[string]Skill
	order  []string // discovery order, for stable listing
	// Agent is the name of the agent currently driving the Flight. When a skill
	// declares an AgentRestriction, the gateway returns an error unless it
	// matches this value. Empty Agent means "no current agent" — a restricted
	// skill is then refused.
	Agent string
}

// NewGateway builds the gateway over the discovered skills. The current agent
// name (empty if none) is used for restriction enforcement.
func NewGateway(skills []Skill, agent string) *Gateway {
	g := &Gateway{
		Base: tool.Base{
			ToolName:        GatewayName,
			ToolDescription: "Load a skill's full instructions on demand by name. Available skills are listed in the system prompt.",
			ToolSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name": map[string]any{
						"type":        "string",
						"description": "The name of the skill to load.",
					},
				},
				"required": []any{"name"},
			},
			ReadOnly:        true,
			ConcurrencySafe: true,
			Expose:          tool.Direct,
		},
		skills: make(map[string]Skill, len(skills)),
		order:  make([]string, 0, len(skills)),
		Agent:  agent,
	}
	for _, s := range skills {
		if _, dup := g.skills[s.Name]; dup {
			continue // first-wins, mirrors the tool registry
		}
		g.skills[s.Name] = s
		g.order = append(g.order, s.Name)
	}
	return g
}

// Skills returns the gateway's skills in discovery order.
func (g *Gateway) Skills() []Skill {
	out := make([]Skill, 0, len(g.order))
	for _, name := range g.order {
		out = append(out, g.skills[name])
	}
	return out
}

// Exec finds the named skill, enforces its agent restriction, loads its body
// lazily, and returns it as the result content. An unknown skill name or a
// restriction mismatch is reported as a tool error result (not a hard error),
// so the failure feeds back to the model rather than aborting the Flight.
func (g *Gateway) Exec(_ context.Context, input map[string]any, _ tool.ExecContext) (tool.Result, error) {
	name, _ := input["name"].(string)
	name = strings.TrimSpace(name)
	if name == "" {
		return tool.Result{Content: "skill: missing required \"name\"", IsError: true}, nil
	}
	s, ok := g.skills[name]
	if !ok {
		return tool.Result{Content: fmt.Sprintf("skill: unknown skill %q", name), IsError: true}, nil
	}
	if s.AgentRestriction != "" && s.AgentRestriction != g.Agent {
		return tool.Result{
			Content: fmt.Sprintf("skill: %q is restricted to agent %q (current agent: %q)", name, s.AgentRestriction, g.Agent),
			IsError: true,
		}, nil
	}
	body, err := s.Body()
	if err != nil {
		return tool.Result{Content: fmt.Sprintf("skill: load %q: %v", name, err), IsError: true}, nil
	}
	return tool.Result{Content: body}, nil
}

// ListingPrompt renders the available skills as a metadata-only block for the
// system prompt (progressive disclosure — bodies are deliberately excluded).
// Returns an empty string when there are no skills.
func ListingPrompt(skills []Skill) string {
	if len(skills) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("Available skills (load a skill's full instructions with the \"")
	b.WriteString(GatewayName)
	b.WriteString("\" tool):\n")
	for _, s := range skills {
		b.WriteString("- ")
		b.WriteString(s.Name)
		if s.Description != "" {
			b.WriteString(": ")
			b.WriteString(s.Description)
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
