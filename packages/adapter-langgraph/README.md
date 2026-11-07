# @galaxie/adapter-langgraph

A native LangGraph executor adapter for galaxie, using the browser `/web` entry,
checkpoint-backed pending interactions and interrupt-ID resume.

## Install

This is a private workspace package. With Node 24 and pnpm 11, run
`pnpm install --frozen-lockfile` and `pnpm build` at the repository root.
Workspace consumers use `@galaxie/adapter-langgraph: workspace:*`.
[package.json](package.json) records the LangChain and LangGraph peers.

## Minimal model-free graph

```ts
import { createLangGraphAdapter, type LangGraphAgent } from '@galaxie/adapter-langgraph';
import { createRuntime, defineAgentDefinition } from '@galaxie/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { z } from 'zod';

const state = Annotation.Root({ value: Annotation<number> });
const agent: LangGraphAgent = (host) => new StateGraph(state)
  .addNode('increment', ({ value }) => ({ value: value + 1 }))
  .addEdge(START, 'increment')
  .addEdge('increment', END)
  .compile({ checkpointer: host.langchain.checkpointer() });
const definition = defineAgentDefinition({
  id: 'docs/counter', version: '0.0.0', executor: 'langgraph-js',
  input: z.object({ value: z.number() }),
});
const runtime = createRuntime({ appId: 'counter-app', executors: [createLangGraphAdapter()] });
const instance = await runtime.create(definition, {
  principalScope: 'demo-learner', agent, services: { chatModels: {} },
});
await instance.prepare();
const { runId } = await instance.start({ value: 0 });
```

`start()` returns before execution finishes. Observe `instance.events(runId)`
and `instance.getSnapshot()`; keep the runtime alive until host teardown, then
`await runtime.dispose()`. Model nodes use `host.langchain.chatModel(role)` with
the node's explicit config. After an await, interactions use
`requestInteraction(request, config)`.

Routed invoke and stream calls forward the lease's `maxTokens` output limit,
including tool-bound calls, structured output and repairs. A lower caller
`maxTokens` wins; other call options are preserved. Supported providers retain any
lower constructor limit. Built-in AI has no output-token limit and ignores this
value. Actual usage may still differ from the reservation. Coverage uses mocks,
fake engines and injected fetch only; no real provider limit behavior is measured.
See [provider limits](../models/README.md#output-token-limits).

## Decision roles

Declare `models: { triage: { modality: 'decision' } }` in the agent definition.
The host supplies a decision descriptor and route through `CreateOptions.models`,
and registers its implementation by provider ID in `services.decisionModels`:

```ts
import type { LangGraphServices } from '@galaxie/adapter-langgraph';
import type { ModelRouting } from '@galaxie/core';
import { MockDecisionModel } from '@galaxie/models/mock';

const services: LangGraphServices = {
  chatModels: {},
  decisionModels: {
    localDecision: new MockDecisionModel([
      { answers: { route: { value: 'ask' } }, usage: { inputTokens: 4, outputTokens: 0 } },
    ]),
  },
};
const models: ModelRouting = {
  providers: {
    localDecision: {
      modality: 'decision', destination: 'in-browser', features: [],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { triage: { providers: ['localDecision'], allow: ['in-browser'], maxTokens: 64 } },
};
// Supply services and models when creating the instance. Inside a graph node:
const answers = await host.langchain.decide('triage', {
  state: { message: 'Example state' },
  questions: {
    route: { type: 'choice', instructions: 'Choose the next route.', options: { ask: 'Ask', answer: 'Answer' } },
  },
}, config);
```

Forward node `config` explicitly, including after an await. Each attempt uses one
ordinary model lease with the active run's sticky labels, consent, cancellation
and token/cost budgets. Preparation requires a decision implementation for each
routed decision descriptor; `credential: true` requires a per-call factory
`({ credential }) => decisionModel`. `chatModel` refuses decision roles, and
`decide` refuses text or unknown roles with `unavailable`.

The request and every answer pass core's
[decision validation](../core/README.md#decision-roles). Both complete values pass
the run's payload budget. The complete answer JSON passes
`checkOutput(json, { final: true })` before delivery; blocked or failed hooks
prevent delivery, and an absent hook retains the text path's `unset` outcome.
Completed calls with invalid answers settle reported usage once before any repair;
attempts that throw charge the reservation once. Route `repairAttempts` defaults
to zero. When enabled, invalid answers with a `raw` string can request a new lease
with `repairAttempt: n`, consuming the shared run repair budget. The selected
decision provider receives `repair: { attempt: n, reply: previousRaw }`; no validator
text is included. Routing, labels, consent and budgets are rechecked for each lease,
which may select another decision provider. Leases never overlap or fall back to
text. Exhaustion fails with fixed `invalid`; missing raw text, malformed results,
provider errors, cancellation, budget failures and blocked or failed output hooks
stop the loop. Generated `raw` passes `checkOutput` before answer validation and
is never returned or stored. Custom executors supplying `RunRequest` directly must supply
its `payload` callback to use decisions; the adapter fails closed without it.

The [structured-output decision provider](../models/README.md#structured-output-decisions)
reuses an available chat model without a nested text lease. Dedicated models,
media, extraction and automatic batching remain outside this implementation.

## Confidence-gated decisions

`gateDecision(answers, gate, config)` adds a registered interaction when any checked
answer lacks confidence or has confidence strictly below the host's threshold.
Equality passes. `threshold` must be finite and in [0, 1]; it comes only from trusted
host configuration, never state, model output or tool output. The host must calibrate
confidence on its own questions and domains before enabling a threshold (ADR-0028).
`questions` optionally restricts the check to named answers; the default checks every
answered question. An empty selection, duplicate or absent name fails with fixed
`invalid`, as does an invalid threshold or non-object interaction.

No confidence always asks, even at threshold zero. Malformed confidence on hand-built
answers counts as missing, and confidence accessors are never invoked. The
structured-output decision provider supplies no confidence, even if its generated
JSON volunteers one, so a gate over that provider always asks. Answers returned by
the gate are detached and frozen.

Keep the decision call and gate in **separate graph nodes**, storing the answers in
graph state. LangGraph re-runs an interrupted node from its start on resume;
combining inference and the gate in one node leases the model again. This helper
does not work around native node re-execution.

```ts
import { gateDecision } from '@galaxie/adapter-langgraph';
import type { DecisionResult, ViewRevision } from '@galaxie/core';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';

const state = Annotation.Root({
  message: Annotation<string>,
  answers: Annotation<DecisionResult['answers']>,
  continue: Annotation<boolean>,
});
// Inside the agent factory; triage and tests.DecisionAsk/v1 are host-bound.
const graph = new StateGraph(state)
  .addNode('decide', async ({ message }, config) => ({
    answers: await host.langchain.decide('triage', {
      state: { message },
      questions: { proceed: { type: 'boolean', instructions: 'May the agent continue?' } },
    }, config),
  }))
  .addNode('gate', ({ answers }, config) => {
    const result = gateDecision(answers, {
      threshold: 0.7, // Host-calibrated configuration, never read from state.
      interaction: {
        component: 'tests.DecisionAsk/v1',
        props: { text: 'Would you like to continue?' },
        surfaceId: 'decision',
        viewRevision: 'v1' as ViewRevision,
      },
    }, config);
    return { continue: result.asked
      ? result.submission?.action === 'continue'
      : result.answers['proceed']?.value === true };
  })
  .addEdge(START, 'decide')
  .addEdge('decide', 'gate')
  .addEdge('gate', END)
  .compile({ checkpointer: host.langchain.checkpointer() });
```

The gate returns `{ answers, asked: false }` when confidence passes, or
`{ answers, asked: true, submission }` after the host dispatches a valid action to
the pending question. The interaction must be host-authored and contain no answers,
state or model text. The helper only adds a question: it never removes, skips or
satisfies capability confirmations, host confirmations, approvals or consent prompts,
and never calls a capability. A confident model decision can still be influenced by
untrusted state; required confirmations remain with the broker.

## Model-chosen capability tools

`host.langchain.capabilityTool(name: string, spec: CapabilityToolSpec)` returns a
LangChain `StructuredToolInterface`. The spec has `description`, a Zod object
schema as `parameters` (for example `z.object(...)`), and optional `toolName`. The
function name defaults to the capability name with punctuation replaced by `_`.
The capability must be declared by the agent and bound by the host.

```ts
const search = host.langchain.capabilityTool('docs.search@1', {
  description: 'Search the host document collection.',
  parameters: z.object({ query: z.string() }),
});
const model = host.langchain.chatModel('assistant').bindTools!([search]);
// Inside a node, forward its explicit config to the model and tools.
const reply = await model.invoke(history, config);
```

`bindTools(tools, kwargs?)` stores declarations on a routed runnable. Each call
requires `tool-calling` during provider selection and then calls the selected
provider's `bindTools`. A role with no provider that declares the feature fails
`unavailable`, as for structured output; a selected provider whose chat model
has no `bindTools` fails `unsupported`. Both fail before provider dispatch. An output-safety block on generated tool arguments fails
`denied` before the tools run. No alternate provider is tried after dispatch.

Execute the chosen calls with a native tool loop, for example
`new ToolNode([search], { handleToolErrors: false })` from
`@langchain/langgraph/prebuilt`, forwarding node config. The helper returns broker
`denied` and `invalid` failures as `{ error: <fixed message> }`, which LangChain
serializes into a `ToolMessage`; other failures propagate and must end the run.
Disable `ToolNode`'s general error handling as above so it does not turn fatal
broker failures into model observations.

Every call goes through the existing broker's labels, grants, validation,
budgets and effect IDs. The helper checks the host binding before offering a
tool to a provider and before invoking it. Only a `read` binding, or a binding
of another kind with `approval: 'confirm'` and a configured host confirmation
registry, is offered; a capability with no broker binding is refused too, and the
call fails with fixed `invalid`. Two declarations with one tool name in the same
`bindTools` call also fail `invalid`. Only `instance.respond(id, 'approve')` approves
the broker's frozen real arguments. Model text or tool output cannot approve it.
Host code owns rendering the confirmation and authorizing backend operations.
A declined confirmation comes back to the model as the fixed `denied` text, and a
model may request the same write again; each request produces a new confirmation,
bounded by the run's tool-call budget, so set that budget for agents that offer
writes.

With recovery, the forwarded full checkpoint namespace and deterministic
per-task call order preserve write receipts across resume, including concurrent
`ToolNode` calls. Without recovery, writes can repeat. Custom tools outside this
helper do not get its write-offering check; see the
[documented limits](../../docs/unsupported.md#execution-and-langgraph). Raw graph
streams and checkpoints can contain arguments and tool results and must not be
used as display data.

The added [tool-loop tests](../../tests/conformance/langgraph-tools.test.ts) target
Node and Chromium with deterministic mock models only. No real-model
tool-calling or injection-resistance result is claimed.

See [coding guidance](AGENTS.md), [explicit context rules and parity](../../tests/conformance/README.md)
and [runtime contracts](../../docs/system-design.md#6-core-runtime-and-contracts).
Parallel interrupts and static breakpoints remain unsupported.
Code is Apache-2.0 (see [LICENSE](../../LICENSE)).

## Materialized surface interrupts

Use `requestSurface(record, config)` for a reduced `galaxie.surface/1` plain JSON
record, built with core's `materializeSurface`. Pass node config explicitly, including
after an await. The adapter reads this record from the checkpoint and core validates
it against host-bound catalogs, regions, limits and URL/private-value policy before
publication or restore. The resume value stays exactly `{ action, payload }`.

One interrupt per node still applies. Advance a surface revision by resuming and
reducing the next batch against the previous record in a later node, then interrupt
with a new ID. Pending interrupts cannot be updated in place. `requestInteraction`
and existing four-field checkpoints are unchanged.
