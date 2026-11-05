// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie

import (
	"encoding/json"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/agent"
	"google.golang.org/adk/tool"
	"google.golang.org/adk/tool/exitlooptool"
	"google.golang.org/adk/tool/functiontool"
	"google.golang.org/adk/tool/toolconfirmation"

	"galaxie.invalid/galaxie/galaxie/llm"
)

const exitLoopName = "exit_loop"

// ToolSpec describes a capability tool: what the model is told and the JSON Schema of its input.
// The host checks the same schema again before the capability runs.
type ToolSpec struct {
	Description string
	// Schema is a JSON Schema object for the tool's input, as JSON.
	Schema string
	// RequireConfirmation holds the call until the user approves it. The capability does not run
	// before then, and a declined call is reported to the model as rejected.
	RequireConfirmation bool
	// LongRunning marks a capability whose real result arrives later: the run runs the capability,
	// pauses with its pending result, and continues when the user supplies the result.
	LongRunning bool
}

// CapabilityTool creates a tool that calls a host capability, for example "math.double@1". The
// model sees the capability name with every character outside letters, digits and underscores
// replaced by "_", so "math.double@1" is "math_double_1".
func CapabilityTool(capability string, spec ToolSpec) (tool.Tool, error) {
	r := active()
	if r == nil || capability == "" {
		return nil, llm.NewError("unsupported")
	}
	// ADK's own confirmation call carries this name; a tool that shares it could forge a pause.
	if toolName(capability) == toolconfirmation.FunctionCallName {
		return nil, llm.NewError("unsupported")
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal([]byte(spec.Schema), &schema); err != nil {
		return nil, llm.NewError("invalid")
	}
	if spec.RequireConfirmation && spec.LongRunning {
		return nil, llm.NewError("unsupported")
	}
	created, err := functiontool.New(functiontool.Config{
		Name:                toolName(capability),
		Description:         spec.Description,
		InputSchema:         &schema,
		IsLongRunning:       spec.LongRunning,
		RequireConfirmation: spec.RequireConfirmation,
	}, func(ctx agent.ToolContext, args map[string]any) (map[string]any, error) {
		return call(ctx, capability, args)
	})
	if err != nil {
		return nil, err
	}
	r.tools[created] = true
	r.pausing = r.pausing || spec.RequireConfirmation || spec.LongRunning
	if spec.LongRunning {
		r.longRunning[created] = true
	}
	return created, nil
}

// ExitLoop creates ADK's exit_loop tool, which ends the enclosing LoopAgent.
func ExitLoop() (tool.Tool, error) {
	r := active()
	if r == nil {
		return nil, llm.NewError("unsupported")
	}
	created, err := exitlooptool.New()
	if err != nil {
		return nil, err
	}
	r.tools[created] = true
	return created, nil
}

func toolName(capability string) string {
	name := strings.Map(func(c rune) rune {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_':
			return c
		default:
			return '_'
		}
	}, capability)
	if name[0] >= '0' && name[0] <= '9' {
		name = "_" + name
	}
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

// call sends one capability call to the page. ADK runs the sibling tools of a model turn on
// separate goroutines, so the whole round trip holds the run's tool lock: after a fatal failure
// the later calls stop before they dispatch.
func call(ctx agent.ToolContext, capability string, args map[string]any) (map[string]any, error) {
	run := llm.FromContext(ctx)
	if run == nil {
		return nil, llm.NewError("unavailable")
	}
	unlock := run.LockTools()
	defer unlock()
	if fatal := run.Fatal(); fatal != nil {
		return nil, fatal
	}
	payload, err := llm.EncodeCapability(llm.CapabilityRequest{
		Name:        capability,
		Input:       args,
		EffectScope: run.EffectScope(ctx.FunctionCallID()),
	})
	if err != nil {
		return nil, run.Fail(err)
	}
	encoded, err := run.Caller().Call(ctx, "capability", payload)
	if err != nil {
		if llm.Recoverable(llm.CodeOf(err)) {
			return nil, llm.NewError(llm.CodeOf(err))
		}
		return nil, run.Fail(err)
	}
	value, err := llm.DecodeCapability(encoded)
	if err != nil {
		return nil, run.Fail(err)
	}
	if object, ok := value.(map[string]any); ok {
		return object, nil
	}
	return map[string]any{"result": value}, nil
}
