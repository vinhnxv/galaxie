# Local-only starter

A copyable Vite + React app with its own tiny LangGraph agent: answer one multiple-choice question, then receive a short model comment. It has no agent backend, remote model endpoint, provider key or tracing exporter. Inference stays in the browser. Model assets require a network connection only after an explicit WebLLM download opt-in.

## Requirements and running

Use Node.js 24 and pnpm 11 through Corepack. The mock needs no GPU or model download. Persistent browser sessions need IndexedDB, Web Locks and BroadcastChannel on a trustworthy origin such as localhost. Built-in AI needs a browser with the English Prompt API model already available. WebLLM needs a compatible WebGPU adapter, including `shader-f16`, and enough memory; detecting `navigator.gpu` alone does not prove those requirements.

From the repository root:

```sh
pnpm install
pnpm build
pnpm --filter local-only-template dev
```

The root build produces the local packages' distribution files. The template's Vite config uses package exports, with no aliases into this checkout. `linkWorkspacePackages: true` in the root workspace configuration links its `^0.1.0` ranges to matching local packages. Both TypeScript compiler chains use `tsconfig.workspace.json` and `test/tsconfig.json` to resolve workspace source before a build; `tsconfig.json` is standalone and keeps the repository's strict compiler options.

Copy this entire directory for a new app. Outside this repository the five `@galaxie/*` dependencies will come from the registry once released. **They are unpublished today**, so a standalone registry install cannot work yet. Once released, use `pnpm install` and `pnpm dev` in the copy. The repository-only source mappings and test tooling are for galaxie's checks; they are not needed to serve a copied app.

## Route order and consent

On load, `checkBuiltInAI` checks availability without creating a session or downloading. An available model becomes the active route. Otherwise a deterministic `MockChatModel` becomes active immediately. The script returns one fixed encouraging sentence and makes no network requests or timing-dependent choices. A browser-managed model that is downloadable or already downloading stays on the mock; this template never calls `prepareBuiltInAI`.

When Built-in AI is unavailable and WebGPU exists, Download opens a native confirmation dialog with the fixed size disclosure. Only accepting it imports the WebLLM provider entry, starts its bundled Worker and imports `@mlc-ai/web-llm`. The declared weights are **868,547,584 bytes (868.547584 decimal MB)**, checked against `defaultWebLLMModel` by a Node test. Runtime, tokenizer and config files add bytes. Download progress uses the provider's content-free fraction, never its raw text. Cancel aborts loading and returns to the offer; it does not erase already cached assets. A late result from a cancelled load is disposed. Failed or declined loading leaves the mock active. Successful loading selects WebLLM for the next model call, including an answer to a question already on screen. A dispatched model call is never retried on another provider.

## Fixed model states

`src/model-state.ts` owns every model message and control label. The UI reads that table; raw errors, URLs, stack traces and user text never become status messages. Each row has one control or none. The native confirmation dialog uses the same offer message.

| State | Message | Control |
| --- | --- | --- |
| `no_api` | Built-in AI is absent. The mock is active. | None |
| `unsupported_languages` | Built-in AI does not support English here. The mock is active. | None |
| `download_required` | Built-in AI needs a browser-managed download of unreported size. The mock is active. | None |
| `activation_required` | Built-in AI needs user activation. The mock is active. | None |
| `download_failed` | The Built-in AI download failed. The mock is active. | None |
| `not_allowed` | Built-in AI is not allowed here. The mock is active. | None |
| `no_webgpu` | WebGPU is absent. WebLLM cannot be offered. | None |
| `offer` | WebLLM is optional: download 868,547,584 bytes (868.547584 MB) of weights. Additional runtime and tokenizer files are required. The mock stays active until loading finishes. | Download |
| `downloading` | WebLLM is downloading. The mock is active. Progress appears separately. | Cancel |
| `failed` | WebLLM could not load. The mock is active. | Retry |
| `declined` | The WebLLM download was declined. The mock is active. | Download again |
| `ready` | WebLLM is ready and active in this browser. | None |

The shared `ModelUnavailableReason` union also includes `no_adapter`, `no_shader_f16`, `adapter_limits`, `device_lost`, `integrity`, `worker_failed`, `load_failed`, `disposed`, `rate_limited`, `endpoint_failed` and `network`. Each has its own fixed message and no control in the exhaustive table. These are shared provider reasons, not additional remote routes. An injected typed Built-in AI probe rejection exercises each reason; the real availability probe normally returns availability rather than throwing typed reasons. All WebLLM loader rejections use the single `failed` state and Retry. The browser's unavailable result is shown as `no_api` when the API is absent, otherwise `unsupported_languages`; `downloadable` and `downloading` map to `download_required`. The six Built-in AI reason names match the model package exactly.

## Persistence and principal identity

The host opens `IndexedDBSaver` with app ID `local-only-template` and principal scope `local-demo-principal`. **Replace that principal placeholder in `src/runtime.ts` with an identity from your trusted sign-in session before adding user data.** The session pointer key derives from both values. Do not accept principal identity from agent input. Keep the same scope for the saver, recovery store and runtime instance. On principal changes, dispose the old host, clear its session pointer and follow your host's principal invalidation and wipe policy before creating a new host.

The browser host acquires core app ownership with the saver's fencing port before creating an instance. It supplies both the checkpointer and `saver.recovery`, saves the pending session pointer in sessionStorage and uses `instance.restore()` after reload. A second active tab must release ownership before Retry can open the question. Pending questions are restored from checkpoints; unsubmitted radio selections are local drafts and reset. The fixed question does not run a model until after the interrupt, so restoring it repeats no inference. Browser eviction can remove checkpoints. Completed results are not a durable history: a fresh load starts a new question after completion. Reload does not resume a model download; it probes Built-in AI again and requires fresh WebLLM consent.

## Policy and limits

The copied CSP directive map follows the local host example: deny by default, same-origin scripts and workers, Trusted Types, no forms navigating away, and no frames, objects or base changes. The default policy allows the pinned model download hosts and worker WASM; `vite build --mode mock` with `vite preview --mode mock` restricts connections to same-origin and permits no Trusted Types policies. Downloads fail in that mode. Serve the same CSP as response headers in production; Vite's development and preview headers do not configure your deployment. The sole Trusted Types script URL rule permits only the bundled worker. The download hosts also receive ordinary asset requests, so local inference does not mean zero network traffic after consent. The worker record pins immutable model URLs; integrity covers config, library and tokenizer, **not weight shards**. Same-origin scripts and dependencies remain trusted.

The agent has no capabilities or external tools. The registry validates quiz props and submissions, and model comments render as React text. Core's destination policy and finite budgets remain in effect. No content filter or answer-quality guarantee is provided; grading this fixed practice question is deterministic local code. This template adds no login, sign-out UI, remote provider, exporter, metrics, model benchmark or scaffolding command.

## Verification and unmeasured behavior

Node tests cover the exhaustive table, declared sizes, dependency and import boundaries, typed probe reasons and a no-network mock run. Chromium tests cover unavailable states, decline, progress, cancellation, failure/Retry, a fake successful WebLLM route and reopened real IndexedDB recovery. A Playwright test in the Node lane builds the mock-policy app, reloads its pending question in Chromium, completes it and checks same-origin traffic with no model asset requests.

The WebLLM loader and Built-in AI probe are injected in automated state tests. The successful WebLLM test uses a fake engine handle, never real inference. **Real-device Built-in AI and WebLLM behavior for this template is unverified**, including first-download size beyond the declared weights, latency, cancellation latency, memory pressure and GPU/device support. Existing host demonstrations do not establish results for this template. The mock is a wiring demonstration, not an evaluation of model quality.

From the root, after installing dependencies:

```sh
pnpm exec vitest run --project node templates/local-only/test
pnpm exec vitest run --project 'browser (chromium)' templates/local-only/test
pnpm check
```
