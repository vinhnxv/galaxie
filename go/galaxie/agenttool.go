// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/agent"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie/llm"
)

// AgentTool wraps one registered capability-free tree in an isolated inner session.
func AgentTool(inner agent.Agent) (tool.Tool, error) {
	r := active()
	if r == nil || inner == nil {
		return nil, llm.NewError("unsupported")
	}
	if _, known := r.agents[inner]; !known {
		return nil, llm.NewError("unsupported")
	}
	created, err := functiontool.New(functiontool.Config{Name: inner.Name(), Description: inner.Description(), InputSchema: &jsonschema.Schema{Type: "object", Properties: map[string]*jsonschema.Schema{"request": {Type: "string"}}, Required: []string{"request"}}}, func(ctx agent.ToolContext, args map[string]any) (map[string]any, error) {
		run := llm.FromContext(ctx)
		if run == nil {
			return nil, llm.NewError("unavailable")
		}
		if fatal := run.Fatal(); fatal != nil {
			return nil, fatal
		}
		request, ok := args["request"].(string)
		if !ok || len(args) != 1 {
			return nil, run.Fail(llm.NewError("invalid"))
		}
		state := map[string]any{}
		for key, value := range ctx.State().All() {
			if !strings.HasPrefix(key, "_adk") {
				state[key] = value
			}
		}
		service := session.InMemoryService()
		stored, err := service.Create(ctx, &session.CreateRequest{AppName: inner.Name(), UserID: ctx.UserID(), State: state})
		if err != nil {
			return nil, run.Fail(err)
		}
		nested, err := runner.New(runner.Config{AppName: inner.Name(), Agent: inner, SessionService: service})
		if err != nil {
			return nil, run.Fail(err)
		}
		var last *genai.Content
		for event, err := range nested.Run(ctx, stored.Session.UserID(), stored.Session.ID(), genai.NewContentFromText(request, genai.RoleUser), agent.RunConfig{StreamingMode: agent.StreamingModeNone}) {
			if err != nil {
				return nil, run.Fail(err)
			}
			if event.ErrorCode != "" || event.ErrorMessage != "" {
				return nil, run.Fail(llm.NewError("unavailable"))
			}
			if fatal := run.Fatal(); fatal != nil {
				return nil, fatal
			}
			if event.Content != nil {
				last = event.Content
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, run.Fail(llm.NewError("cancelled"))
		}
		if fatal := run.Fatal(); fatal != nil {
			return nil, fatal
		}
		if last == nil {
			return map[string]any{}, nil
		}
		parts := []string{}
		for _, part := range last.Parts {
			if part != nil && part.Text != "" && !part.Thought {
				parts = append(parts, part.Text)
			}
		}
		answer := strings.Join(parts, "\n")
		if answer == "" {
			return map[string]any{}, nil
		}
		return map[string]any{"result": answer}, nil
	})
	if err != nil {
		return nil, err
	}
	r.tools[created] = true
	r.agentTools[created] = inner
	return created, nil
}

func (r *recorder) validateAgentTools(root agent.Agent) error {
	names := map[string]bool{}
	path := map[agent.Agent]bool{}
	var walk func(agent.Agent, bool, int) error
	walk = func(current agent.Agent, inner bool, depth int) error {
		info, known := r.agents[current]
		if !known || depth > maxDepth || path[current] || names[current.Name()] {
			return llm.NewError("unsupported")
		}
		names[current.Name()] = true
		path[current] = true
		defer delete(path, current)
		if inner && (info.model != nil && !info.wrapAllowed || len(info.tools) != 0) {
			return llm.NewError("unsupported")
		}
		hasWrapper := false
		toolNames := map[string]bool{}
		duplicate := false
		for _, each := range info.tools {
			duplicate = duplicate || toolNames[each.Name()]
			toolNames[each.Name()] = true
			if wrapped := r.agentTools[each]; wrapped != nil {
				hasWrapper = true
				if inner {
					return llm.NewError("unsupported")
				}
				if err := walk(wrapped, true, depth+1); err != nil {
					return err
				}
			}
		}
		if hasWrapper && duplicate {
			return llm.NewError("unsupported")
		}
		for _, child := range current.SubAgents() {
			if err := walk(child, inner, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(root, false, 1)
}
