# Framework feasibility: Vercel AI SDK

Checked on 2026-11-07 against `ai` **7.0.164** (published 2026-11-06, Apache-2.0, Node
`>=22`, Git tag `ai@7.0.164`) with `@ai-sdk/provider` 4.0.36 and `@ai-sdk/provider-utils`
5.0.75. The notes read the published tarball, which ships `dist/` and the matching
`docs/`, and the repository at the tag. A browser bundle was built once with esbuild
(below); no agent loop was run in a browser. Statements marked *unverified* are open
items, not findings. The 7.x line moves fast (about 164 patch releases), and several
features that matter here are marked experimental.

**Verdict: go, as a bounded spike.** It is the best fit of the three: the model seam is a
small documented interface, approvals are plain message history that the application
owns, and the core bundle imports no Node built-ins statically. The first adapter work
must run the loop in a real tab.

## Does it run in a browser?

- No document says the core loop runs in a browser. The README lists frameworks and
  runtimes and requires Node.js 22+ on the development machine
  ([README](https://unpkg.com/ai@7.0.164/README.md)); the 7.0 migration guide says
  "AI SDK 7.0 requires Node.js 22 or later"
  ([migration guide](https://unpkg.com/ai@7.0.164/docs/08-migration-guides/23-migration-guide-7-0.mdx)).
- `package.json` has no `browser`, `edge-light` or `workerd` condition and no CJS build;
  `sideEffects` is false ([package.json](https://unpkg.com/ai@7.0.164/package.json)).
  The test scripts cover Node and an edge runtime, not a browser.
- `dist/index.js` has no static `node:` import. `node:diagnostics_channel` and
  `node:async_hooks` load through `process.getBuiltinModule()` only when the runtime is
  Node, and the approval signature uses the global Web Crypto API
  ([tracing-channel-publisher.ts](https://github.com/vercel/ai/blob/ai@7.0.164/packages/ai/src/telemetry/tracing-channel-publisher.ts),
  [index.js](https://unpkg.com/ai@7.0.164/dist/index.js)).
- `@ai-sdk/provider-utils` has a Node-only download path (`node:module`, `node:dns`,
  `undici`) that runs only on Node; elsewhere it uses `fetch`
  ([URL fetching](https://unpkg.com/ai@7.0.164/docs/06-advanced/11-secure-url-fetching.mdx)).
- The package ships browser code of its own (realtime transports) and an in-process
  `DirectChatTransport` whose documented uses are SSR, tests and single-process apps
  ([DirectChatTransport](https://unpkg.com/ai@7.0.164/docs/07-reference/02-ai-sdk-ui/50-direct-chat-transport.mdx)).
- Measured here, not documented: an entry importing `ToolLoopAgent`, `tool`,
  `isStepCount` and `zod` bundled with `esbuild --platform=browser --minify` without
  errors, at 776,474 bytes minified and 176,636 bytes gzip. About 454 KB of that is
  `zod`; the SDK packages are about 320 KB. This is a build, not a run.

## Tool loop

- `ToolLoopAgent` takes `model`, `instructions`, `tools`, `stopWhen`, `prepareStep` and
  `toolApproval`, and offers `generate()` and `stream()`
  ([reference](https://unpkg.com/ai@7.0.164/docs/07-reference/01-ai-sdk-core/16-tool-loop-agent.mdx)).
  Tools are `tool({ inputSchema, execute })` with Zod or JSON Schema.
- The loop ends on a finish reason other than `tool-calls`, a tool without `execute`, a
  tool call that needs approval, or a stop condition. `isStepCount(n)` is the step limit
  (default 20 for the agent); `prepareStep` can change the model, messages and tool
  choice before each step
  ([loop control](https://unpkg.com/ai@7.0.164/docs/03-agents/04-loop-control.mdx)).
- A throwing `execute` becomes a `tool-error` part that feeds the next step
  ([tools](https://unpkg.com/ai@7.0.164/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx)).
- Nothing in the loop needs an HTTP agent backend: `execute` is a host function and the
  model is an object. A browser-tab example is not given (*unverified*).

## Human-in-the-loop

- `toolApproval` (the older per-tool `needsApproval` is deprecated) yields statuses
  `not-applicable`, `approved`, `denied` or `user-approval`, set per tool, per call or per
  call preparation. It applies only to tools the SDK executes, and subagent tools cannot
  use it
  ([tool approvals](https://unpkg.com/ai@7.0.164/docs/03-agents/06-tool-approvals.mdx)).
- The run does not pause in memory. It completes and returns `tool-approval-request`
  parts. The caller appends the response messages and a `tool-approval-response`, then
  calls the agent again; an approved tool runs on that second call and a denied one
  produces an `execution-denied` result (same page).
- The paused state is the message history, which the application stores. On the second
  call the SDK re-validates the input against the schema and re-evaluates the approval
  policy, and rejects a history whose approved input has changed (same page).
  JSON-serializability of history with non-JSON parts such as `Uint8Array` is
  *unverified*.
- Approvals in a client-held history can be forged. `experimental_toolApprovalSecret`
  signs them with an HMAC but is opt-in and experimental. In a browser-only app the
  history already sits in the user's own storage, the same same-origin trust limit the
  other galaxie adapters document.
- A tool without `execute` returns control to the caller; resuming a plain
  `ToolLoopAgent` by appending a tool result is not shown in the pages read
  (*unverified*). Durable suspend and resume exist only in the separate
  `WorkflowAgent` and `HarnessAgent` APIs, which are not needed here.

## State

- The application owns all state. There is no checkpoint API in `ToolLoopAgent`; message
  persistence and stream resume are patterns the application builds
  ([message persistence](https://unpkg.com/ai@7.0.164/docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx),
  [resume streams](https://unpkg.com/ai@7.0.164/docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx)).
  `DirectChatTransport` does not support stream reconnection
  ([transport](https://unpkg.com/ai@7.0.164/docs/04-ai-sdk-ui/21-transport.mdx)).

## Model seam

- `LanguageModel` accepts a model object (`LanguageModelV4`, `V3` or `V2`) as well as a
  gateway string, and older specs are wrapped by adapters
  ([index.d.ts](https://unpkg.com/ai@7.0.164/dist/index.d.ts),
  [providers and models](https://unpkg.com/ai@7.0.164/docs/02-foundations/02-providers-and-models.mdx)).
- `LanguageModelV4` is `specificationVersion`, `provider`, `modelId`, `supportedUrls`,
  `doGenerate(options)` and `doStream(options)`; the options carry `prompt`,
  `responseFormat`, `tools`, `toolChoice`, `abortSignal` and `providerOptions`, and
  `doStream` returns a `ReadableStream` of typed parts
  ([types](https://unpkg.com/@ai-sdk/provider@4.0.36/dist/index.d.ts)). A custom
  provider guide documents the interface
  ([custom providers](https://github.com/vercel/ai/blob/ai@7.0.164/content/providers/05-community-providers/01-custom-providers.mdx)).
  Whether V4 stays unchanged across 7.x is *unverified*; a new spec version has appeared
  with each major release, with adapters for the previous ones.
- `abortSignal` and `timeout` are supported, and `Output.object` and related helpers give
  structured output that works alongside tools
  ([structured data](https://unpkg.com/ai@7.0.164/docs/03-ai-sdk-core/10-generating-structured-data.mdx)).
  `MockLanguageModelV4` ships for tests.

## Telemetry

- OpenTelemetry moved to a separate package, `@ai-sdk/otel`, registered with
  `registerTelemetry`; once registered, calls emit telemetry unless a call opts out
  ([telemetry](https://unpkg.com/ai@7.0.164/docs/03-ai-sdk-core/60-telemetry.mdx)). The
  Node tracing channel in `ai` is a no-op outside Node. Lifecycle callbacks
  (`onStart`, `onStepEnd`, `onToolExecutionEnd` and others) exist without OpenTelemetry.
  Whether telemetry works in a browser tab is *unverified*; galaxie would write its
  filtered spans from the lifecycle callbacks and leave telemetry unregistered.

## How it maps onto the executor contract

| Contract piece | Mapping |
| --- | --- |
| `features` | `streaming` and `interrupts` can be declared; `resume` re-runs the agent over stored history; `checkpoints` is the stored history; `subgraphs` is false. |
| `prepare(agent, services)` | `agent` is a `ToolLoopAgent` factory; `services` carries tools and the host's `models`. |
| `run` with `start` | `agent.stream({ messages, abortSignal })`, parts mapped to `ExecutorEvent`. |
| Model calls | A `LanguageModelV4` whose `doGenerate` and `doStream` forward to `request.models`, so authorization, labels, budgets and output safety stay in core. |
| Capabilities | Tool `execute` functions call `request.capabilities`; `toolApproval` returns `user-approval` for confirm-level bindings. |
| Pause and `resume` | A `tool-approval-request` part becomes a pending interaction; the submission becomes a `tool-approval-response` appended to the stored history before the agent is called again. |
| `pending` | Read the stored history and report unanswered approval requests. |
| Abort | Pass `request.signal` as `abortSignal`. |

Resume re-runs the agent over the whole history. A step that already ran must not repeat
its writes: this matches galaxie's existing "re-execution on resume" rule, which keys
write replay on session and call order.

## What it would need from the adapter kit

- Selected-provider resolution and text extraction for the model wrapper (exist).
- A checkpoint store for the message history, with its contents re-registered as private
  through `registerRestoredData` (new work).
- A fixed error mapping for tool, schema and tool-choice errors.
- A decision on `zod`: the SDK imports `zod/v4` and lists `zod` as a peer, so the
  adapter's size budget would count a package that is mostly `zod`.

## Open items an adapter must close first

1. Run a tool loop with a custom `LanguageModelV4` in a real tab, with `process` absent.
2. Confirm the approval request and response round trip through a stored history, and that
   a denied approval reaches the model as intended.
3. Confirm the gateway import is inert when no gateway string is used and that no request
   leaves the page except through the router.

Not measured: the loop's behavior in a tab, history size after many steps, and the
bundle once `zod` is shared with the host.
