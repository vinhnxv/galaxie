# @galaxie-ai/adapter-adk

> This package is experimental and is not published to a package registry. Its API can change in any commit without notice.

The Google ADK (JavaScript) executor adapter (executor id `adk-js`). It pins ADK, runs its
browser bundle under galaxie's strict CSP and Trusted Types, and hosts agents through galaxie's
router, broker and budgets, with checked streaming, pauses for confirmations and long-running
tools, and durable sessions. See
[ADR-0020](../../docs/adr/0020-google-adk-through-an-adapter.md) (Accepted).

## Adapter

`createAdkAdapter()` registers `adk-js` with `streaming`, `interrupts`, `resume` and `checkpoints` set
to `true` and `subgraphs` set to `false`. The run input is `{ prompt: string }`.
The agent factory receives a host and returns an ADK agent:

```ts
const agent: AdkAgent = (host) =>
  new LlmAgent({
    name: 'agent',
    model: host.adk.llm('answer'),
    instruction: 'Answer briefly.',
    tools: [host.adk.capabilityTool('docs.search@1', { description: '...', parameters })],
  });
```

- `host.adk.llm(role)` is the only model source. It leases the router for each call, so routing,
  labels, consent, output safety and budgets apply. ADK model classes are rejected at prepare and
  flagged by `galaxie/no-direct-model`.
- `host.adk.capabilityTool(name, spec)` calls a bound capability through the broker. A `denied` or
  `invalid` result returns a fixed message to the model; every other failure ends the run.
  The model chooses when it runs, so a capability that is not a read runs through this helper only
  when it is bound with `approval: 'confirm'` and the runtime has host confirmation coverage for it
  (`confirmations` on `runtime.create`). Otherwise the call is refused with the fixed `invalid`
  message before it reaches the capability. A capability name with no binding is refused the same
  way. A tool you write yourself, outside this helper, is not covered by this check.
- Prepare accepts only `LlmAgent`, `SequentialAgent`, `ParallelAgent` and `LoopAgent`, with models
  and tools created by the host. Anything else fails closed.
- The adapter creates the `Runner`, an in-memory event log and one tool-call integrity plugin, and
  sets `maxLlmCalls` from the step budget. A run that reaches that limit fails `budget_exceeded`.
- The run output is the final response text, or the session-state value at the final agent's
  `outputKey`.

## Streaming

Provider invoke and stream calls receive `maxTokens` from the router lease,
lowered by ADK's `maxOutputTokens` when it is a positive integer (other values are ignored). Tool-bound and schema calls use
the same limit. Supported providers retain any lower constructor limit; Built-in
AI has no output-token limit and ignores the value. Actual usage may still differ
from the reservation. Coverage uses mocks and injected provider fakes only; no
real provider limit behavior is measured. See
[provider limits](../models/README.md#output-token-limits).

The adapter always runs ADK in SSE mode, so a run emits `stream` events with `executor: 'adk-js'` and
an empty `path`:

- `messages` carries `{ author, text }`, one event per provider text chunk (split at 4096
  characters). The reply so far, including call arguments, passes the host's output-safety hook
  before the chunk reaches ADK, so a blocked chunk is never delivered and earlier chunks are not
  retracted. A block fails the run `denied`.
- `updates` carries `{ step, tool, index }` with `step` `tool_call` or `tool_result`, the offered tool
  name and a run-wide position. It never carries a call ID, an argument or a result.

Stream data is delivered live and is not journaled. A provider without native streaming yields its
whole reply as one chunk. The final response ADK records carries the whole reply, so the run output
does not depend on the deltas. Abort or an early stop settles the model call once, as failed.

### Attributing nested messages

The [stream namespace spike](../../docs/adr/0020-google-adk-through-an-adapter.md#stream-namespaces-workflow-agents-and-subgraphs-spike-2026-11)
records an **alternative**, not nested stream support. For a tree whose agent names
are globally unique, the host can build its own below-root lookup and attribute
messages without changing the event:

```ts
const paths = new Map([
  ['drafter', ['sequence', 'drafter']],
  ['reviewer', ['sequence', 'reviewer']],
]);
if (event.type === 'stream' && event.mode === 'messages') {
  const author = (event.data as { author: string }).author;
  const displayPath = paths.get(author);
  // Render displayPath in the host's own UI.
}
```

Build the lookup from the same static tree the factory returns, and reject
ambiguous names in the host's lookup rather than changing executor admission.
Tool and paused markers carry no author; Parallel messages interleave. Duplicate
leaves in different Sequential subtrees have the same author and branch, so their
ancestry cannot be recovered this way. `subgraphs` stays false: event paths remain
empty, scopes stay positional, PendingInteraction carries no path and no namespace
is stored. These are display labels, not checkpoint or authorization keys.

Workflow is **refused** under the spike rule. Static FunctionNode lists alone do
not establish routed model calls, and full routed-graph replacement is unmeasured.
SequentialAgent/ParallelAgent cover static chains and fan-out; dynamic routes,
cycles and retries have no demonstrated replacement here.

## Pauses and resume

A tool created with `requireConfirmation: true`, or with `longRunning: true`, can stop the run to
wait for the user. The factory may return `defineAdkEntry({ agent, interaction, resume })` instead of
a bare agent:

```ts
const agent: AdkAgent = (host) =>
  defineAdkEntry({
    agent: new LlmAgent({ /* ... */ tools: [host.adk.capabilityTool('files.delete@1', spec)] }),
    interaction: (requests) => ({
      surfaceId: 'main',
      viewRevision: 'r1',
      component: 'app.Approval/v1',
      props: { tools: requests.map((request) => request.tool) },
    }),
  });
```

- A pause ends the run with one `interaction` event and the run resumes as a new run when the user
  submits. Without an `interaction` hook, or when it returns anything but the four-field request
  core accepts, the run fails `unsupported` with a fixed message.
- `interaction(requests)` and `resume(requests, action, payload)` see positional requests
  (`confirmation` with the tool and its arguments, or `long-running` with the tool and arguments).
  ADK call IDs never reach author code, props or the user interface. All requests from one model
  response form one interaction. The interaction ID is a digest of the conversation ID and the pause
  number, so later pauses get new IDs.
- The default `resume` handles confirmations only: action `approve` or `deny` with payload
  `{ indexes: [0, ...] }` covering every pending request exactly once. Anything else fails `invalid`
  and runs nothing. A pause that includes a long-running call needs an author `resume`, which returns
  `{ confirmed }` for a confirmation and `{ response }` (a plain JSON object) for a long-running call.
- A resume whose interaction ID is not the pending one fails `stale` before any tool runs. ADK's
  confirmation processor and the tool-call integrity plugin stay enabled, so an altered stored
  request fails the resume.
- ADK limits: when one model turn calls a confirmation-gated tool beside other tools (including a
  long-running one), ADK drops the other tools' results or splits the answer across events, so the
  adapter fails that turn `unsupported`. A pause inside a tree that holds a `ParallelAgent`, and a
  long-running call whose result never arrives, fail `unsupported` too. A pause abandoned without a
  valid answer is answered with a denial before the next `start`, so history stays well-formed. ADK also hides
  `adk_request_input` calls and answers from an `LlmAgent`, so `host.adk.requestInput()` fails the
  run `unsupported`; use a long-running tool with an ordinary, non-reserved name and a validating
  author `resume` to ask the user a question. Do not name a capability tool `adk_request_input`:
  it is admitted and invokes its capability before failing without an answerable pause. The
  [scripted Node/Chromium spike](../../docs/adr/0020-google-adk-through-an-adapter.md#confirmation-beside-calls-and-request-input-spike-2026-11)
  therefore records request input as refused under its reserved-name criterion.
- Durable sessions: pass `services.checkpoints` (the `byteRecords` port of `IndexedDBSaver`). After a
  run pauses or completes, the adapter writes one `adk.session/v1` record holding the conversation
  events, the pause ordinal and the pending interaction. The per-session integrity key for ADK's
  tool-call stamps is stored beside it in the record metadata, so it is never part of a personal-content
  export. Restore (`instance.restore()`) validates the record against a closed schema, registers its
  text as private data before ADK can reach a model, and rebuilds the plugin from the stored key, so
  a stored pause must match the stamped calls in the events (name and arguments) or the record is `unrecoverable`, and an altered stamped call fails `invalid` when the run resumes. Core's private data is cleared at each run end, so every run of a store-backed session registers the stored history again before ADK can replay it. A corrupt, spliced or oversize record fails
  `unrecoverable`. Failed and cancelled runs write nothing and are undone in memory (events and state), so a restore
  returns to the last stored state. A record is limited to 4 MiB; a longer conversation fails
  `unsupported` and cannot continue. Partial events and binary parts are never stored. Without `services.checkpoints` sessions
  stay in memory, as before. The effect scope of a write is position-derived, so an approved write
  whose run crashed replays its receipt after the restore. One active owner per session applies, as for
  the other executors; the example host is a later stage.

## Supported agent shapes

Native ADK and the adapter run the same scripted model requests and return the same output for
`SequentialAgent`, `LoopAgent`, `ParallelAgent` (request tags compared sorted, because branch arrival order
varies) and an `LlmAgent` with `subAgents` that transfers ([agents.test.ts](test/agents.test.ts)).
Two `ParallelAgent` branches that each call a write capability get their own position-derived
scopes: after a failed run, the re-dispatch with reversed branch completion order replays each
receipt, so no write runs twice (needs a recovery store). `subgraphs` stays `false`.

- ADK resumes directly at the paused agent only when that agent and all its ancestors are
  `LlmAgent`s; otherwise it restarts from the root, and a `SequentialAgent` or `LoopAgent` runs
  from its first child (the native test shows this for `SequentialAgent`). A pause would run
  earlier siblings, and their writes, again in a `LoopAgent`, in a later child of a
  `SequentialAgent`, or under an `LlmAgent` inside a workflow agent, so it fails `unsupported`.
  The same holds in any tree that contains a `ParallelAgent`, and for an unknown or
  duplicate-named pausing agent. A pause in the first child at every `SequentialAgent` step, or in
  a chain of `LlmAgent`s linked by transfer, resumes in place and survives a reload.
- `AgentTool` and `Workflow` fail `unsupported` at prepare. Re-admitting `AgentTool` needs an
  adapter-owned wrapper with its own run config, integrity plugin and session keying.

## Other facts for hosts

- The adapter installs a no-op ADK logger, which is process-global, so it also silences ADK logging
  for other code in the page.
- The bundle needs `crypto.subtle` for the tool-call integrity plugin. It ships under Apache-2.0
  with inlined lodash (MIT) and `@google/genai` (Apache-2.0).
- The per-session integrity key guards in-flight forgery and corrupt history. It does not protect
  against a writer of the store.
- ADK still emits content-free spans of its own to a registered global OpenTelemetry provider.
  Responses that an agent-level model callback replaces are not re-checked (ADR-0002).

## Install

This is a private workspace package. With Node 24 and pnpm 11, run
`pnpm install --frozen-lockfile` and `pnpm build` at the repository root.
[package.json](package.json) pins `@google/adk` exactly to 2.3.0, with `@langchain/core` and
`zod` as peers.

## Host requirements the probe measured

The adapter imports only the root specifier `@google/adk`, which the `browser` export condition
resolves to the self-contained `dist/web/index_web.js`. Hosts that load that bundle must:

- **Run the zod jitless configuration before the bundle module is evaluated.** The bundle inlines
  zod and shares `globalThis.__zod_globalConfig` with the repository's copy. Without
  `config({ jitless: true })` it calls `new Function('')`, which Trusted Types blocks. Keep the
  configuration in the host entry: a package marked `"sideEffects": false` can lose a
  side-effect-only import of it.
- **Register an OpenTelemetry provider before the bundle is evaluated** if they want ADK's own
  spans (`invocation`, `invoke_agent`, `call_llm`, `execute_tool`). The bundle inlines the
  OpenTelemetry API and registers through the shared global.
- **Turn span content capture off at build time.** ADK records prompts, replies, tool arguments
  and results as span attributes unless `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` is `"false"`. A
  Vite build replaces `process.env` with `{}` inside the bundle, so only a define reaches it:

  ```ts
  define: { 'process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS': JSON.stringify('false') }
  ```

  Where `process.env` is not replaced (a dev server), `ensureAdkRuntimeEnv()` from
  [src/runtime-shim.ts](src/runtime-shim.ts) creates a frozen env-only `process` when none exists,
  or sets only that flag when unset. Without it, ADK throws on its first span and turns the throw
  into an ordinary error event.

## Tests

`pnpm exec vitest run packages/adapter-adk` runs the bundle probe on Node and Chromium, the
strict-CSP Chromium page (the `bundle-csp` test, which builds and serves four small pages),
the shim tests and the bundle-file pin. The pin test fails when the ADK release or its web
bundle changes: a bump is separate work (ADR-0020 decision 2).
