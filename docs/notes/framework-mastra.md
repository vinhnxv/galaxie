# Framework feasibility: Mastra

Checked on 2026-11-07 against `@mastra/core` **1.82.0** (published 2026-11-04,
Apache-2.0 with a separately licensed `ee/` part, Node `>=22.13.0`). The notes read the
published tarball, its bundled documentation and mastra.ai. Nothing was run: no bundle
was built and no browser was started, so every statement about browsers is static
analysis. Statements marked *unverified* are open items, not findings.

**Verdict: no-go for the launch window.** Mastra documents a server runtime, its core
bundle imports Node built-ins at the top level and ships no browser build, and its
defaults include network calls that galaxie's egress rules would have to switch off.
Revisit if the project publishes a browser-safe entry point.

## Does it run in a browser?

- No documentation says `@mastra/core` runs in a browser. The agent, installation and
  storage pages are silent on a client runtime
  ([agents](https://mastra.ai/docs/agents/overview),
  [installation](https://mastra.ai/docs/getting-started/installation),
  [storage](https://mastra.ai/docs/memory/storage)). The documented pattern is a
  browser UI calling a Mastra server through `@mastra/client-js`
  ([client SDK](https://cdn.jsdelivr.net/npm/@mastra/core@1.82.0/dist/docs/references/docs-server-mastra-client.md)).
- The package declares `engines.node >=22.13.0`, has no `browser` field and no `browser`
  export condition, and uses only `import`, `require`, `types` and `default`
  ([package.json](https://cdn.jsdelivr.net/npm/@mastra/core@1.82.0/package.json)). Its
  `./browser` subpath is tooling for agents that drive a web browser, and imports `fs`,
  `path`, `os`, `net` and `events`
  ([browser docs](https://cdn.jsdelivr.net/npm/@mastra/core@1.82.0/dist/docs/references/docs-browser.md)).
- The chunk that holds the `Agent` class and loop (about 3.4 MB unminified) imports
  `crypto`, `stream/web`, `events`, `fs`, `path` and `async_hooks` at its top level, and
  other chunks import `child_process`, `os`, `http`, `https`, `net` and `dns`
  (tarball `dist/`, from `npm pack @mastra/core@1.82.0`). A browser bundle would have to
  alias or polyfill them, or tree shaking would have to drop them.
- `Mastra` depends on `execa`, `ws`, `hono`, `posthog-node` and `dotenv`
  ([package.json](https://cdn.jsdelivr.net/npm/@mastra/core@1.82.0/package.json)). The
  model router reads and writes `~/.cache/mastra/provider-registry.json` and reads
  environment variables such as `MASTRA_GATEWAY_URL` and `MASTRA_OFFLINE` (tarball
  `dist/provider-registry-*.js`).
- Whether `Agent` plus `createTool` plus the in-memory store bundles and runs in a tab
  is *unverified*. A community thread reports a Vite `stream/web` error when core types
  reach a frontend, seen only as a search snippet (*unverified*).

## Tool loop

- `new Agent({ id, name, instructions, model })` loops until a final answer or a stop
  condition; `maxSteps` defaults to 5 and `stopWhen` is supported
  ([agents](https://mastra.ai/docs/agents/overview),
  [generate](https://mastra.ai/reference/agents/generate)).
- The loop is itself a workflow (`agentic-loop`) that persists snapshots through the
  storage layer (tarball `dist/agent-*.js`), so a run depends on the storage domain and
  not only on a model and tools.
- Tools are `createTool({ id, inputSchema, execute })`. A tool without `execute` is a
  client tool and ends the run with `finishReason: 'tool-calls'`
  ([tools](https://mastra.ai/docs/agents/tools)). What the model sees when `execute`
  throws is not documented.

## Human-in-the-loop

- `requireApproval: true` on a tool, or `requireToolApproval: true` on a call, pauses the
  run; streaming resumes with `approveToolCall` or `declineToolCall`, and `generate()`
  returns `finishReason: 'suspended'`. Tools and workflows can also `suspend()` with a
  payload and resume with data that matches a schema
  ([human-in-the-loop](https://mastra.ai/docs/agents/human-in-the-loop),
  [workflows](https://mastra.ai/docs/workflows/suspend-and-resume)).
- Suspended state needs configured storage; without it a resume fails with "snapshot not
  found". Snapshots are deleted when a run finishes, and the default in-memory store
  loses them when the process exits. The snapshot type is `WorkflowRunState | string`
  (tarball `dist/storage/types.d.ts`); whether it round-trips as plain JSON is
  *unverified*.
- A function-valued `requireToolApproval` cannot be persisted and falls back to approving
  every call (same page), which would need to be refused under galaxie's approval rules.

## State

- Storage adapters implement domains under `MastraCompositeStore`; the documentation lists
  server databases (libSQL, PostgreSQL, Redis, DynamoDB and others) and says libSQL file
  storage fails on ephemeral file systems. An in-memory store is the default
  ([storage](https://mastra.ai/docs/memory/storage)). The documentation does not cover
  writing a custom adapter, and no browser-compatible adapter is documented
  (*unverified* for the sibling packages).

## Model seam

- `model` accepts a `provider/model` string, an OpenAI-compatible object, an AI SDK
  model object, a function, or a fallback array
  ([models](https://mastra.ai/models)). The resolver wraps any object with callable
  `doGenerate` and `doStream`, so a host-supplied model looks possible (tarball
  `dist/llm-*.js`; not run).
- `abortSignal`, streaming and `structuredOutput` (Zod, Standard Schema or JSON Schema)
  are supported
  ([generate](https://mastra.ai/reference/agents/generate),
  [structured output](https://mastra.ai/docs/agents/structured-output)).

## Telemetry and egress

- Core has no OpenTelemetry dependency; OpenTelemetry export lives in separate packages
  ([OTel bridge](https://cdn.jsdelivr.net/npm/@mastra/core@1.82.0/dist/docs/references/reference-observability-tracing-bridges-otel.md)).
  Span context uses `AsyncLocalStorage` (tarball `dist/observability/context-storage.js`).
- Product telemetry through `posthog-node` is on by default and is turned off with
  `MASTRA_TELEMETRY_DISABLED`. It sends operating-system, Node version and a hashed host
  identifier, and runs `git remote get-url origin`
  (tarball `dist/feature-telemetry-*.js`). A license client calls `https://license.mastra.ai`
  (tarball `dist/license/index.js`). Both would have to be disabled to meet galaxie's
  egress rules.

## License

- The npm field says Apache-2.0. The shipped `LICENSE.md` states that anything under a
  directory named `ee/` falls under a separate enterprise license, and that third-party
  parts keep their own
  ([LICENSE.md](https://cdn.jsdelivr.net/npm/@mastra/core@1.82.0/LICENSE.md)). That
  license is source-available and requires a written agreement and a key for production
  use ([ee/LICENSE](https://raw.githubusercontent.com/mastra-ai/mastra/main/ee/LICENSE),
  read at `main`, not at the tag). The package contains `dist/auth/ee/` and
  `dist/agent-builder/ee/`, and the agent chunk imports from a shared chunk named `ee-*`;
  which functions fall under the enterprise license is *unverified*.
- An Apache-2.0 launch package depending on a package with a mixed license would need a
  dependency-license review and an allowlist decision before any adapter work.

## Weight

- 18.5 MB tarball, 89 MB unpacked, 29 direct dependencies, including aliased copies of
  `@ai-sdk/provider` for three major versions
  ([npm](https://www.npmjs.com/package/@mastra/core)). No browser bundle size is
  documented or measured.

## What an adapter would need

Even with the three obstacles gone, it would need a browser-safe core entry, an
in-browser storage adapter for loop snapshots and a way to run the loop without the
workflow engine's server assumptions. None of that is in the adapter kit's scope; it
would be upstream work.
