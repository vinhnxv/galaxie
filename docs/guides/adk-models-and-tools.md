# Porting Google ADK models and tools

Use the host's model role and narrow capability bindings when porting an ADK
sample. The [original spike](../adr/0020-google-adk-through-an-adapter.md#string-models-toolsets-code-executors-planners-and-built-in-tools-spike-2026-11)
recorded six alternatives (explicit models and flat tool lists across three
executors) and nine refusals (network built-ins, code executors and planners).
The later [host inventory outcome](../adr/0020-google-adk-through-an-adapter.md#host-role-inventories-for-model-strings-and-fixed-toolsets-2026-11)
ships declared-role strings and fixed toolsets on Python, and fixed toolsets on
Go. The [JavaScript retry](../adr/0020-google-adk-through-an-adapter.md#javascript-host-inventory-retry-2026-11)
ships opt-in declared-role strings and the exported fixed-toolset helper.

| Shape | `adk-js` | `adk-python` | `adk-go` |
| --- | --- | --- | --- |
| Model string equal to a declared role | **SHIPPED** with `defineAdkEntry({ agent, roleStrings: true })`; otherwise **REFUSED** | **SHIPPED**: exact declared roles, with Gemini-looking strings refused | Not applicable: `Config.Model` has no string form; use `galaxie.Model(role)` |
| Gemini or foreign model objects | **REFUSED** before model dispatch | **REFUSED** before model dispatch | **REFUSED** before model dispatch |
| Fixed toolset of capability tools | **SHIPPED**: exported `adkToolset(host, tools)`; a flat list also works | **SHIPPED**: `galaxie.adk.toolset` | **SHIPPED**: `galaxie.Toolset` |
| Dynamic, nested, MCP or OpenAPI toolsets | **REFUSED** | **REFUSED** | **REFUSED** |
| Built-in network tools: search, URL, retrieval, maps | **REFUSED**: no provider-tool carriage | **REFUSED**: no provider-tool carriage | **REFUSED**: no provider-tool carriage |
| Code executors | **REFUSED**: no established isolation seam | **REFUSED**: no established isolation seam | **REFUSED**: no native field |
| Planners | **REFUSED**: thinking config and PlanReAct final retagging do not carry through | **REFUSED**: same gap | **REFUSED**: no native field |

For input, see [asking the user a question](adk-request-input.md): Python has an
**ALTERNATIVE**; JavaScript's ordinary-name pattern works while the native-input
mapping remains **REFUSED**; Go is **REFUSED** by source fact.

## Replace native model strings and objects

Role names belong to host policy. They do not select a provider client inside
the agent. Declare and route `answer` in the host definition and model policy.
Prefer non-provider role names such as `answer`.

### JavaScript: opt in to host roles or build a fresh tree

Before: this native sample shape is refused at prepare with zero model requests.

<!-- snippet: model-before-js -->
```ts
import { LlmAgent } from '@google/adk';
import type { AdkAgent } from '@galaxie-ai/adapter-adk';

export const modelBefore: AdkAgent = () =>
  new LlmAgent({ name: 'root', model: 'gemini-2.5-flash' });
```

After: build the `LlmAgent` and its model inside the factory for each host.

<!-- snippet: model-after-js -->
```ts
import { LlmAgent } from '@google/adk';
import type { AdkAgent } from '@galaxie-ai/adapter-adk';

export const modelAfter: AdkAgent = (host) =>
  new LlmAgent({ name: 'root', model: host.adk.llm('answer') });
```

The [JavaScript guide tests](../../packages/adapter-adk/test/author-guides.test.ts)
prepare this factory twice sequentially, disposing each result, and twice
concurrently. Each run finishes `done` with one routed `answer` request.
Host-created models belong to one preparation, so build helper-based trees in
the factory. Alternatively, keep `model: 'answer'` on the author tree and return
`defineAdkEntry({ agent, roleStrings: true })` from the factory. The host must
declare and route that exact role. Matching does not trim whitespace, fold case
or interpret a display name as an alias; empty strings and undeclared roles
refuse `unsupported`. Prefer role names such as `answer` over provider names.

The opt-in states that a string names host policy rather than a provider model.
Without it, including a factory returning a bare agent, strings remain refused.
Admission checks exact classes and data fields and runs a host-owned copy without
writing to the author objects. Repeated and concurrent preparations can reuse a
string tree, including frozen agents. Agent object identity is not preserved:
callbacks and ADK traversal see the copy. Live fields changed after construction
are retained. Models still pass through the same router, labels, consent, output
checks and budgets; no provider client or network path is added.

### Python: use a declared role string or explicit helper

Before: an ordinary provider string such as `gemini-2.5-flash` is not a
galaxie routing declaration. After: an exact host-declared role string is
admitted and replaced by the router-backed model:

<!-- snippet: model-string-py -->
```python
from google.adk.agents import LlmAgent

from galaxie.adk import Executor


def create_model():
    # The host must declare the answer role in the agent definition.
    return Executor(LlmAgent(name='root', model='answer'))
```

The [CPython guide tests](../../python/galaxie/tests/test_adk_author_guides.py)
declare `answer` and observe exactly one bridge model request for that role.
An undeclared `answer` string and a declared `gemini-2.5-flash` string each
refuse `unsupported` with no bridge messages. The explicit `llm('answer')`
helper also works, as the toolset example below demonstrates.

The optional ADK-only boot inventory is bounded to 256 roles of 1–128 characters.
Over-long names and surplus roles are omitted without a host-visible error; an
author naming an omitted role sees only `unsupported` at prepare, so keep names short.
See [role admission details](../../packages/adapter-pyodide/README.md#porting-adk-models-and-static-toolsets).
A Gemini-looking role can satisfy ADK's built-in name predicate through the
explicit helper, as the original spike records; it still refuses as a Python
model string and does not admit a built-in tool.

### Go: use the explicit model constructor

There is no before-string form: native `llmagent.Config.Model` is an interface,
not a string. Use `galaxie.Model("answer")` inside the build function.
Import `google.golang.org/adk/agent`,
`google.golang.org/adk/agent/llmagent` and
`galaxie.invalid/galaxie/galaxie`.

<!-- snippet: model-go -->
```go
func buildGuideModel() (agent.Agent, error) {
	return galaxie.LlmAgent(llmagent.Config{
		Name: "root", Model: galaxie.Model("answer"),
	})
}
```

The [native Go guide test](../../go/galaxie/author_guides_test.go) calls
`galaxie.Execute` with this build function and a scripted caller: output
`done`, one model request for `answer`, no capability call.

## Replace static toolsets

Before: a native `BaseToolset` or foreign toolset is outside the admitted
surface. For a fixed set, build capability tools from a static specification.
The host declares and binds every capability. These are read examples;
writes still require host-rendered confirmation coverage under
[ADR-0012](../adr/0012-security-baseline.md).

### JavaScript: group a fixed list or pass it flat

<!-- snippet: toolset-js -->
```ts
import { LlmAgent } from '@google/adk';
import { z } from 'zod';
import type { AdkAgent } from '@galaxie-ai/adapter-adk';

export const toolsetAgent: AdkAgent = (host) => {
  const specs = [{ capability: 'math.double@1', toolName: 'double', description: 'Double.' }];
  const tools = specs.map((spec) =>
    host.adk.capabilityTool(spec.capability, {
      toolName: spec.toolName,
      description: spec.description,
      parameters: z.object({ value: z.number() }),
    }),
  );
  return new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools });
};
```

Bind `math.double@1` as a read with input and output `{ value: number }`.
The scripted run calls it once with `{ value: 21 }`, receives
`{ value: 42 }` and finishes `done`. The test compares every model request's
tool declarations and the final result with a native `BaseToolset` expansion
under the same script. To group that list, import `adkToolset` from
`@galaxie-ai/adapter-adk` and use `tools: [adkToolset(host, tools)]` instead.
The exported function leaves the host object's keys unchanged. It copies and
freezes a non-empty list of this host's capability tools and expands it in order
at its authored position. Source-array mutation does not change the group.
Foreign, dynamic, nested, empty, control-tool and duplicate-name groups refuse
`unsupported`; duplicate names against flat tools or other groups also refuse.
Confirmation and long-running pause positions, effect scopes and reload records
match the flat list. Built-in tools, provider configuration, code executors and
planners remain refused. The new executable proofs live in the adapter's role
string and toolset tests; the existing guide snippets stay unchanged.

### Python: group this boot's capability tools

<!-- snippet: toolset-py -->
```python
from google.adk.agents import LlmAgent

from galaxie.adk import Executor, capability_tool, llm, toolset

TOOL_SPECS = (
    ('double', 'math.double@1', 'Double an integer.'),
    ('square', 'math.square@1', 'Square an integer.'),
)
VALUE_PARAMETERS = {
    'type': 'object', 'properties': {'value': {'type': 'integer'}},
    'required': ['value'],
}


def create_toolset():
    tools = [capability_tool(name, capability, VALUE_PARAMETERS, description)
             for name, capability, description in TOOL_SPECS]
    agent = LlmAgent(name='root', model=llm('answer'), tools=[toolset(tools)])
    return Executor(agent)
```

Bind the two named read capabilities in the host. The test calls
`math.double@1` once with `{ value: 21 }` and returns `{ value: 42 }`.
Both model requests have the same ordered declarations as the flat list,
and the final text is `done`. Empty, nested, foreign, control-tool and
duplicate-name groups remain refused, as recorded in the host inventory outcome.

### Go: group this build's capability tools

In addition to the model imports above, import
`google.golang.org/adk/tool`.

<!-- snippet: toolset-go -->
```go
func buildGuideToolset() (agent.Agent, error) {
	const schema = `{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"]}`
	var tools []tool.Tool
	for _, name := range []string{"flat@1", "math.double@1", "last@1"} {
		created, err := galaxie.CapabilityTool(name, galaxie.ToolSpec{
			Description: "Double an integer.", Schema: schema,
		})
		if err != nil {
			return nil, err
		}
		tools = append(tools, created)
	}
	set, err := galaxie.Toolset(tools[1:]...)
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{
		Name: "root", Model: galaxie.Model("answer"),
		Tools: tools[:1], Toolsets: []tool.Toolset{set},
	})
}
```

Flat tools precede toolset members. The native Go test compares grouped and flat
declarations in order, calls `math.double@1` once with `{ value: 21 }`,
receives `{ value: 42 }` and finishes `done` after two model requests.
A duplicate member refuses `unsupported` before dispatch.

## What stays refused

Built-in search/grounding, URL loading, retrieval/Vertex, maps and enterprise
tools remain refused where those shapes exist. They add provider configuration
rather than an ordinary function call; the converter rejects that configuration.
Use a narrow host-bound read capability for application data access. Host MCP
capability bindings go through `tools-mcp`. This is general integration guidance,
not a same-script replacement for a provider-native built-in.

Dynamic or network toolsets have no proven replacement for per-turn lists.
Code executors stay refused: the spikes did not establish an execution isolation
seam; Go has no native executor field. No generated code runs in these examples.
The thinking planner stays refused because its provider thinking configuration
does not cross the router boundary. Go has no native planner field.

### PlanReAct has no same-script replacement

These shapes refuse `unsupported` before any model request on their respective
executors.

JavaScript:

<!-- snippet: planner-before-js -->
```ts
import { LlmAgent, PlanReActPlanner } from '@google/adk';
import type { AdkAgent } from '@galaxie-ai/adapter-adk';

export const plannerBefore: AdkAgent = (host) =>
  new LlmAgent({
    name: 'root',
    model: host.adk.llm('answer'),
    planner: new PlanReActPlanner(),
  });
```

Python:

<!-- snippet: planner-before-py -->
```python
from google.adk.agents import LlmAgent
from google.adk.planners import PlanReActPlanner

from galaxie.adk import Executor, llm


def create_planner():
    # Refused by galaxie at preparation, before a model request.
    agent = LlmAgent(name='root', model=llm('answer'), planner=PlanReActPlanner())
    return Executor(agent)
```

Under the identical scripted reply
`/*PLANNING*/think/*FINAL_ANSWER*/done`, native PlanReAct returns final text
`done` on JavaScript and CPython. A planner-less galaxie run returns the entire
tagged reply unchanged on each. JavaScript's native thought part keeps the
planning/final markers; Python's thought part is `think`. This is a measured
gap, not a workaround: no same-script replacement exists in the recorded
evidence. Adding instruction text does not reproduce response retagging.

The JavaScript `AgentTool` wrapper also stays **REFUSED** after the
[read-only admission rerun](../adr/0020-google-adk-through-an-adapter.md#read-only-admission-rerun-2026-11-13):
both admission variants failed copied temporary-state parity with native ADK.
This guide offers no wrapper migration.

The [independent Python and Go assessment](../adr/0020-google-adk-through-an-adapter.md#measured-outcome-2026-11-14)
keeps both AgentTool wrappers **REFUSED**. Python's candidate misses a collision
between an inner `transfer_to_agent` name and ADK's injected transfer tool; Go's
candidate repeats completed-restore call IDs and defers wasm refusal until start.
Python Workflow also stays **REFUSED**: completed graph restore fails, and the
tree replacement differs in exact requests despite matching final text and write
counts. No new helper, policy flag or migration ships. Historical Python
candidate Chromium runs are recorded separately; Firefox, WebKit, real models
and devices remain unmeasured for the assessment.

## Evidence and limits

The JavaScript snippets run on Node and headless Chromium with scripted models.
The Python snippets run on CPython with a scripted bridge, including the native
PlanReAct comparison; these examples have no dedicated Chromium/Worker run.
The Go snippets run natively through `galaxie.Execute` on pinned Go 1.27.3;
their code blocks are not new wasm/browser scenarios. Existing Worker and
wasm evidence for shipped admission is recorded separately in the host inventory
outcome.

Firefox, WebKit, real models, devices, Worker-hosted JavaScript and exhaustive
external toolsets remain unmeasured for these examples. The
[snippet equality test](../../tests/conformance/adk-author-guides.node.test.ts)
keeps all executable blocks tied to their test-owned sources. The examples
change no runtime admission, persisted format or existing conformance artifact.
