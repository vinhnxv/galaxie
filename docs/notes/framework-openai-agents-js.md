# Framework feasibility: OpenAI Agents SDK for JavaScript

Checked on 2026-11-07 against `@openai/agents`, `@openai/agents-core` and
`@openai/agents-openai` **0.21.0** (published 2026-10-20, MIT, pre-1.0). The notes read
the published tarballs and the documentation at Git tag `v0.21.0`. Nothing was run:
no bundle was built and no browser was started. Statements marked *unverified* are
open items for any adapter work, not findings.

**Verdict: go, as a bounded spike.** The loop, approvals and model seam map onto the
executor contract on paper, and the SDK documents a browser build. Three open items
(below) decide whether a real adapter is worth building.

## Does it run in a browser?

- Officially supported runtimes are server-side: Node.js 22+, Deno 2.35+ and Bun 1.2.5+.
  Browsers sit under "Limited support": "The core SDK can be bundled for browser use,
  but tracing is disabled by default there."
  ([troubleshooting](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/troubleshooting.mdx)).
  The README shows a browser only for Realtime voice agents
  ([README](https://github.com/openai/openai-agents-js/blob/v0.21.0/README.md)).
- Node APIs live behind `@openai/agents-core/_shims`, which has `browser`, `node`,
  `workerd` and `react-native` conditions
  ([package.json](https://unpkg.com/@openai/agents-core@0.21.0/package.json)). The
  browser variant has no `node:` imports and replaces `AsyncLocalStorage` with a
  hand-written stack, not true async-context propagation
  ([shims-browser.mjs](https://unpkg.com/@openai/agents-core@0.21.0/dist/shims/shims-browser.mjs)).
  A bundler must apply the `browser` condition to that subpath.
- The MCP server classes are stubs that throw under the browser shim (same file).
- `@openai/agents` re-exports Realtime, which depends on `ws`
  ([package.json](https://unpkg.com/@openai/agents@0.21.0/package.json)). Whether that
  bundles cleanly for a browser is *unverified*; the smaller `@openai/agents-core` plus
  a custom model avoids it.
- The `openai` client library blocks browser use unless `dangerouslyAllowBrowser` is
  set ([openai-node README](https://raw.githubusercontent.com/openai/openai-node/master/README.md),
  not pinned to the installed version). The Agents SDK never sets it
  ([openaiProvider.mjs](https://unpkg.com/@openai/agents-openai@0.21.0/dist/openaiProvider.mjs)).
  A galaxie adapter would not use the OpenAI client, because every call goes through the
  router (see below).

## Tool loop

- Tools are `tool({ name, description, parameters, execute })`; `parameters` takes Zod
  4, a Standard Schema value or raw JSON Schema
  ([tools](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/tools.mdx)).
- The loop calls the model, runs tool calls locally, appends results and repeats until
  a final output, a handoff to another agent, or `MaxTurnsExceededError` (`maxTurns`
  defaults to 10)
  ([running agents](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/running-agents.mdx)).
- Tool failures return a fixed string to the model unless a custom `errorFunction` is
  given. A tool `timeoutMs` is supported (tools guide).
- The loop lives in `agents-core` and needs no SDK server; the documentation does not
  claim it runs in a tab (*unverified* as an official statement).

## Human-in-the-loop

- `needsApproval` (boolean or async function) pauses the run. The result carries
  `interruptions`; each is resolved with `state.approve()` or `state.reject()`, then
  `run(agent, state)` resumes. Partial resolution works, and the flow also works for
  streaming and for nested agent tools
  ([human-in-the-loop](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/human-in-the-loop.mdx)).
- `RunState` serializes to a string and restores with `RunState.fromString(agent, text)`.
  The snapshot holds the turn counter, model responses, generated items, pending
  approvals, tool-use tracking and the application context. It does not hold the agent
  graph: the resuming process rebuilds the same agents
  ([runState.mjs](https://unpkg.com/@openai/agents-core@0.21.0/dist/runState.mjs)).
- The documentation warns that `fromString` does not authenticate the snapshot or the
  reviewer and recommends keeping the snapshot in server-held storage. Under galaxie
  the snapshot would sit in the user's own IndexedDB, so it shares the same-origin
  trust limit the other adapters already document.

## State

- The application owns storage. The `Session` interface has five methods (`getSessionId`,
  `getItems`, `addItems`, `popItem`, `clearSession`); `MemorySession` is for local
  development and `OpenAIConversationsSession` stores history at OpenAI
  ([sessions](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/sessions.mdx)).
  `conversationId` and `previousResponseId` are OpenAI-hosted state and apply to the
  Responses API only.
- Nothing ships for browser storage. Whether the repository's `examples/memory/` has
  one is *unverified*.

## Model seam

- `Model` is `getResponse(request)` plus `getStreamedResponse(request)`;
  `ModelProvider` is `getModel(name)`
  ([model.d.ts](https://unpkg.com/@openai/agents-core@0.21.0/dist/model.d.ts)). A
  provider is supplied through `new Runner({ modelProvider })`, `setDefaultModelProvider`
  or a `Model` instance on the agent
  ([models](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/models.mdx)).
- A custom model must produce the SDK's own normalized items and usage, not the
  Responses wire format. The documentation's custom-provider example does not match the
  shipped stream event types, so the exact streaming contract needs a read of the
  source before work starts.
- `ModelRequest.signal` carries the `AbortSignal` passed to `run()`. Structured output
  uses `outputType` (Zod, Standard Schema or JSON Schema).
- Importing `@openai/agents` installs the OpenAI provider and tracing exporter as a
  side effect
  ([index.mjs](https://unpkg.com/@openai/agents@0.21.0/dist/index.mjs)). Whether
  `@openai/agents-core` alone leaves no default provider is *unverified*.

## Telemetry

- Default tracing posts spans to `https://api.openai.com/v1/traces/ingest`. It is off in
  browsers and can be disabled (`OPENAI_AGENTS_DISABLE_TRACING`, `tracingDisabled`,
  `setTracingDisabled`)
  ([tracing](https://raw.githubusercontent.com/openai/openai-agents-js/v0.21.0/docs/src/content/docs/guides/tracing.mdx)).
  Because the guard is the same flag, custom processors are also bypassed in a browser
  unless it is turned back on (inferred from code, *unverified*).
- No OpenTelemetry bridge ships. galaxie's filtered spans would be written by the
  adapter from the run's `RunTrace`, with the SDK's own tracing off.

## How it maps onto the executor contract

| Contract piece | Mapping |
| --- | --- |
| `features` | `streaming`, `interrupts`, `resume` and `checkpoints` could be declared; `subgraphs` is false (handoffs are not nested graphs). |
| `prepare(agent, services)` | `agent` is an SDK agent graph factory; `services` carries tools and the host's `models`. |
| `run` with `start` | `run(agent, input, { stream: true, signal, maxTurns })`, events mapped to `ExecutorEvent`. |
| Model calls | A `Model` that forwards each call to `request.models` (the router), so authorization, labels, budgets and output safety stay in core. |
| Capabilities | Tool `execute` functions call `request.capabilities`. |
| Pause and `resume` | `needsApproval` produces an interaction; `RunState.toString()` is the checkpoint; resume restores it and calls `approve`/`reject` from the submission. |
| `pending` | Read the stored `RunState` and report its approvals. |
| Abort | Pass `request.signal` as the run's `signal`. |

## What it would need from the adapter kit

- Selected-provider resolution for the model wrapper (exists).
- Text extraction for the SDK's message items (exists, but the item shape is new).
- A checkpoint store for the serialized `RunState` and re-registration of its contents as
  private through `registerRestoredData`, because the snapshot holds model output and
  context. This is new work.
- A fixed error mapping for `MaxTurnsExceededError`, `ToolCallError`,
  `ToolTimeoutError` and `ModelBehaviorError`.

## Open items an adapter must close first

1. Build `@openai/agents-core` with the `browser` condition and run a tool loop in a
   real tab with a custom `Model`; confirm the hand-written `AsyncLocalStorage` holds
   under concurrent runs.
2. Confirm the streaming event contract of a custom `Model` from the source.
3. Confirm nothing in the core entry reaches the network without the host's model, and
   that tracing stays off.

Not measured: bundle size (no figure is published), pause latency and snapshot size.
