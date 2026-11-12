// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package galaxie_test

// NA1/NA2: native tree authors and Parallel branches match hand-written oracles.
// A-go REFUSED under the registered native gate: T6 cannot run because native
// ADK requires globally unique names. This contradicts the validity prediction.
// Galaxie acceptance gates are not applicable after NA1; the bridge additionally
// carries no tree/path field. The unique-name recipe below is partial evidence.
// AL1/AL2: existing streaming model-request authors support a message-only recipe.
// AL3: markers lack author, duplicates are ambiguous and Parallel interleaves.
// B-go REFUSED: pinned-source absence, checked by parsing production Go files.
// C-go REFUSED derives from A-go; subgraphs remains false.

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"iter"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/agent/workflowagents/loopagent"
	"google.golang.org/adk/agent/workflowagents/parallelagent"
	"google.golang.org/adk/agent/workflowagents/sequentialagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/runner"
	"google.golang.org/adk/session"
	"google.golang.org/genai"

	"galaxie.invalid/galaxie/galaxie"
	"galaxie.invalid/galaxie/galaxie/llm"
)

type namespaceNative struct{ name string }

func (m *namespaceNative) Name() string { return m.name }
func (m *namespaceNative) GenerateContent(_ context.Context, _ *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		part := &genai.Part{Text: m.name}
		if m.name == "root" {
			part = &genai.Part{FunctionCall: &genai.FunctionCall{Name: "transfer_to_agent", Args: map[string]any{"agent_name": "specialist"}}}
		}
		yield(&model.LLMResponse{Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{part}}, TurnComplete: true}, nil)
	}
}

func namespaceTree(t *testing.T, shape string, native bool) agent.Agent {
	t.Helper()
	must := func(created agent.Agent, err error) agent.Agent {
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	leaf := func(name string, children ...agent.Agent) agent.Agent {
		config := llmagent.Config{Name: name, SubAgents: children}
		if native {
			config.Model = &namespaceNative{name: name}
			return must(llmagent.New(config))
		}
		config.Model = galaxie.Model(name)
		return must(galaxie.LlmAgent(config))
	}
	sequence := func(name string, children ...agent.Agent) agent.Agent {
		config := agent.Config{Name: name, SubAgents: children}
		if native {
			return must(sequentialagent.New(sequentialagent.Config{AgentConfig: config}))
		}
		return must(galaxie.SequentialAgent(config))
	}
	parallel := func(children ...agent.Agent) agent.Agent {
		config := agent.Config{Name: "root", SubAgents: children}
		if native {
			return must(parallelagent.New(parallelagent.Config{AgentConfig: config}))
		}
		return must(galaxie.ParallelAgent(config))
	}
	switch shape {
	case "sequential":
		return sequence("root", leaf("drafter"), leaf("reviewer"))
	case "parallel":
		return parallel(leaf("left"), leaf("right"))
	case "nested":
		return parallel(sequence("sequence", leaf("a"), leaf("b")), leaf("c"))
	case "loop":
		config := agent.Config{Name: "root", SubAgents: []agent.Agent{leaf("worker")}}
		if native {
			return must(loopagent.New(loopagent.Config{AgentConfig: config, MaxIterations: 2}))
		}
		return must(galaxie.LoopAgent(config, 2))
	case "transfer":
		return leaf("root", leaf("specialist"))
	case "duplicate":
		return sequence("root", sequence("first", leaf("worker")), sequence("second", leaf("worker")))
	default:
		t.Fatalf("unknown shape %s", shape)
		return nil
	}
}

var namespaceOracles = map[string][]string{
	"sequential": {"drafter|", "reviewer|"},
	"parallel":   {"left|root.left", "right|root.right"},
	"nested":     {"a|root.sequence", "b|root.sequence", "c|root.c"},
	"loop":       {"worker|", "worker|"},
	"transfer":   {"root|", "specialist|"},
}

func TestNativeStreamNamespaceIdentity(t *testing.T) {
	for shape, expected := range namespaceOracles {
		t.Run(shape, func(t *testing.T) {
			ctx := context.Background()
			service := session.InMemoryService()
			if _, err := service.Create(ctx, &session.CreateRequest{AppName: "identity", UserID: "user", SessionID: "session"}); err != nil {
				t.Fatal(err)
			}
			r, err := runner.New(runner.Config{AppName: "identity", Agent: namespaceTree(t, shape, true), SessionService: service})
			if err != nil {
				t.Fatal(err)
			}
			var actual []string
			for event, err := range r.Run(ctx, "user", "session", genai.NewContentFromText("go", genai.RoleUser), agent.RunConfig{}) {
				if err != nil {
					t.Fatal(err)
				}
				if event.Content != nil && event.Content.Role == genai.RoleModel {
					actual = append(actual, event.Author+"|"+event.Branch)
				}
			}
			slices.Sort(actual)
			want := slices.Clone(expected)
			slices.Sort(want)
			if !slices.Equal(actual, want) {
				t.Fatalf("identity = %v, want %v", actual, want)
			}
		})
	}
	if _, exists := reflect.TypeFor[session.Event]().FieldByName("NodeInfo"); exists {
		t.Fatal("native node-path premise changed")
	}
}

type namespaceCaller struct {
	mu      sync.Mutex
	authors []string
}

func (c *namespaceCaller) Call(_ context.Context, op string, payload []byte) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if op != "model" {
		return nil, llm.NewError("unsupported")
	}
	var request llm.ModelRequest
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, err
	}
	if request.Author == "" {
		return nil, llm.NewError("invalid")
	}
	if request.Author == "root" {
		return []byte(calls("transfer_to_agent", `{"agent_name":"specialist"}`)), nil
	}
	c.authors = append(c.authors, request.Author)
	return []byte(reply(request.Author)), nil
}

func TestStreamNamespaceAuthorRecipeUsesTheExistingBridge(t *testing.T) {
	oracles := map[string][]string{
		"sequential": {"drafter", "reviewer"}, "parallel": {"left", "right"},
		"nested": {"sequence/a", "sequence/b", "c"}, "loop": {"worker", "worker"}, "transfer": {"specialist"},
	}
	for shape, expected := range oracles {
		t.Run(shape, func(t *testing.T) {
			caller := &namespaceCaller{}
			paths := map[string]string{}
			entry := func() (agent.Agent, error) {
				root := namespaceTree(t, shape, false)
				var visit func(agent.Agent, []string)
				visit = func(current agent.Agent, path []string) {
					paths[current.Name()] = strings.Join(path, "/")
					for _, child := range current.SubAgents() {
						visit(child, append(slices.Clone(path), child.Name()))
					}
				}
				visit(root, nil)
				return root, nil
			}
			_, err := galaxie.Execute(context.Background(), caller, entry, galaxie.Input{Prompt: "go", Conversation: "c", Stream: true})
			if err != nil {
				t.Fatal(err)
			}
			actual := make([]string, len(caller.authors))
			for index, author := range caller.authors {
				actual[index] = paths[author]
			}
			slices.Sort(actual)
			want := slices.Clone(expected)
			slices.Sort(want)
			if !slices.Equal(actual, want) {
				t.Fatalf("recipe paths = %v, want %v", actual, want)
			}
		})
	}
	for _, field := range []string{"Path", "Branch", "Tree"} {
		if _, exists := reflect.TypeFor[llm.ModelRequest]().FieldByName(field); exists {
			t.Fatalf("bridge carriage premise changed: %s", field)
		}
	}
}

func TestNativeStreamNamespaceDuplicateTreeIsRefused(t *testing.T) {
	leaf := func() agent.Agent {
		created, err := llmagent.New(llmagent.Config{Name: "worker", Model: &namespaceNative{name: "worker"}})
		if err != nil {
			t.Fatal(err)
		}
		return created
	}
	first, err := sequentialagent.New(sequentialagent.Config{AgentConfig: agent.Config{Name: "first", SubAgents: []agent.Agent{leaf()}}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := sequentialagent.New(sequentialagent.Config{AgentConfig: agent.Config{Name: "second", SubAgents: []agent.Agent{leaf()}}})
	if err != nil {
		t.Fatal(err)
	}
	root, err := sequentialagent.New(sequentialagent.Config{AgentConfig: agent.Config{Name: "root", SubAgents: []agent.Agent{first, second}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = runner.New(runner.Config{AppName: "identity", Agent: root, SessionService: session.InMemoryService()})
	if err == nil || !strings.Contains(err.Error(), "agent names must be unique") {
		t.Fatalf("duplicate-tree result = %v", err)
	}
}

func TestStreamNamespaceDuplicateLeavesAreAlreadyRefused(t *testing.T) {
	caller := &namespaceCaller{}
	_, err := galaxie.Execute(context.Background(), caller, func() (agent.Agent, error) {
		first, err := galaxie.LlmAgent(llmagent.Config{Name: "worker", Model: galaxie.Model("worker")})
		if err != nil {
			return nil, err
		}
		second, err := galaxie.LlmAgent(llmagent.Config{Name: "worker", Model: galaxie.Model("worker")})
		if err != nil {
			return nil, err
		}
		a, err := galaxie.SequentialAgent(agent.Config{Name: "first", SubAgents: []agent.Agent{first}})
		if err != nil {
			return nil, err
		}
		b, err := galaxie.SequentialAgent(agent.Config{Name: "second", SubAgents: []agent.Agent{second}})
		if err != nil {
			return nil, err
		}
		return galaxie.SequentialAgent(agent.Config{Name: "root", SubAgents: []agent.Agent{a, b}})
	}, galaxie.Input{Prompt: "go", Conversation: "c", Stream: true})
	assertCode(t, err, "unsupported")
	if len(caller.authors) != 0 {
		t.Fatalf("refused tree dispatched authors = %v", caller.authors)
	}
}

func TestStreamNamespacePinnedModuleHasNoWorkflowGraph(t *testing.T) {
	output, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "google.golang.org/adk").Output()
	if err != nil {
		t.Fatal(err)
	}
	directory := strings.TrimSpace(string(output))
	if directory == "" {
		t.Fatal("pinned ADK module directory is empty")
	}
	files := 0
	err = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		files++
		if parsed.Name.Name == "workflow" {
			t.Errorf("workflow package now exists: %s", path)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			if spec, ok := node.(*ast.TypeSpec); ok && spec.Name.Name == "Workflow" {
				t.Errorf("Workflow type now exists: %s", path)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if files == 0 {
		t.Fatal("no pinned ADK production sources inspected")
	}
}
