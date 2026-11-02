# @galaxie/adapter-adk

The Google ADK (JavaScript) executor adapter (executor id `adk-js`). It pins ADK, runs its
browser bundle under galaxie's strict CSP and Trusted Types, and hosts agents through galaxie's
router, broker and budgets, with checked streaming. See
[ADR-0020](../../docs/adr/0020-google-adk-through-an-adapter.md) (Proposed).

## Adapter (stage A3)

`createAdkAdapter()` registers `adk-js` with `streaming` set to `true` and `interrupts`, `resume`,
`checkpoints` and `subgraphs` set to `false`. The run input is `{ prompt: string }`.
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
- Prepare accepts only `LlmAgent`, `SequentialAgent`, `ParallelAgent` and `LoopAgent`, with models
  and tools created by the host. Anything else fails closed.
- The adapter creates the `Runner`, an in-memory event log and one tool-call integrity plugin, and
  sets `maxLlmCalls` from the step budget. A run that reaches that limit fails `budget_exceeded`.
- The run output is the final response text, or the session-state value at the final agent's
  `outputKey`.

## Streaming

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

Long-running tools, confirmations, durable sessions and the example host are later stages.

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
