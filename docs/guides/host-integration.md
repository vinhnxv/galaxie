# Host integration

The host owns authentication, backend authorization, rendering, model preparation
and runtime teardown. galaxie constrains SDK-controlled paths; reviewed agents,
XSS and other same-origin code can bypass those paths. Read the
[mandatory baseline](../adr/0012-security-baseline.md),
[security review](../security-review.md) and [package guidance](../../llms.txt)
alongside these integration steps. The seven launch packages (`@galaxie/ui-protocol`,
`@galaxie/core`, `@galaxie/adapter-kit`, `@galaxie/adapter-langgraph`, `@galaxie/models`,
`@galaxie/storage-indexeddb` and `@galaxie/react`) are versioned 0.1.0 and not published
to a registry yet.
The other packages remain private workspace packages.

## Layer map

| Layer | What you gain | What you still own |
| --- | --- | --- |
| [0: run an agent in the page](#layer-0-run-an-agent-in-the-page) | A graph, model router and interactive surface with memory checkpoints | Host lifecycle and application policy; nothing survives reload |
| [1: persist, recover, own](#layer-1-persist-recover-own) | Scoped checkpoints, recovery and tab ownership | Trusted principal identity, session pointers and cleanup |
| [2: harden](#layer-2-harden) | Deployment controls, invalidation, confirmations and output/export controls | Deployment configuration, backend authority and the documented limits |

These layers are a learning order. The mandatory baseline still applies before
deployment; the detailed topic sections below remain the integration reference.

## Layer 0: run an agent in the page

Start from a copy of the [local-only template](../../templates/local-only/README.md),
keeping its Vite + React setup. In the copy, use the two snippets below as
`src/agent.ts` and `src/main.tsx`. The agent is verbatim from
[`templates/local-only/src/agent.ts`](../../templates/local-only/src/agent.ts);
the host wiring reduces
[`templates/local-only/src/runtime.ts`](../../templates/local-only/src/runtime.ts)
and its [entry point](../../templates/local-only/src/main.tsx) to a memory-only
host, so you can diff the snippets against those files.

To try it inside this repository, copy the template to a new directory under
`templates/`, give the copy's `package.json` a new name, replace the two files,
and run the following from the repository root (use your copy's package name):

```sh
pnpm install
pnpm build
pnpm --filter <your-package-name> dev
```

The packages are unpublished, so a standalone registry install is not available
yet. The mock needs no GPU, model download, provider key or agent backend. The
snippets were built and run in Chromium on the mock during review of this guide;
that is a check of this page's code, not a result for any real model or device.

`src/agent.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type LangGraphAgent, requestInteraction } from '@galaxie/adapter-langgraph';
import { type AgentDefinition, defineAgentDefinition } from '@galaxie/core';
import type { QuizSubmission } from '@galaxie/react';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { z } from 'zod';

const inputSchema: z.ZodType<Record<string, never>, Record<string, never>> = z.strictObject({});

interface TemplateDefinition extends AgentDefinition {
  readonly input: typeof inputSchema;
}

export const templateDefinition: TemplateDefinition = defineAgentDefinition({
  id: 'local-only.starter',
  version: '0.0.0',
  executor: 'langgraph-js',
  input: inputSchema,
  models: {
    comment: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
  },
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['question'] },
});

export const commentPrompt = 'Give one short encouraging sentence about practicing.';

const state = Annotation.Root({ result: Annotation<string> });

/** The interrupt precedes the model call, so restoring the question repeats no inference. */
export function createTemplateAgent(): LangGraphAgent {
  return (host) =>
    new StateGraph(state)
      .addNode('question', async (_state, config) => {
        const submission = requestInteraction(
          {
            surfaceId: 'question',
            component: 'education.Quiz/v1',
            viewRevision: 'question-v1',
            props: {
              title: 'A tiny local agent',
              questions: [
                {
                  id: 'sum',
                  prompt: 'What is 2 + 2?',
                  options: [
                    { id: 'four', label: '4' },
                    { id: 'five', label: '5' },
                  ],
                },
              ],
            },
          },
          config,
        );
        const { answers } = submission.payload as QuizSubmission;
        const reply = await host.langchain
          .chatModel('comment')
          .invoke([new HumanMessage(commentPrompt)], config);
        const grade = answers['sum'] === 'four' ? 'Correct.' : 'The answer is 4.';
        return { result: `${grade} ${reply.text}` };
      })
      .addEdge(START, 'question')
      .addEdge('question', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
}
```

`src/main.tsx`:

```tsx
import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, type ModelDescriptor } from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import { AgentSurface, createRegistry, ModelRoutes, Quiz } from '@galaxie/react';
import { createRoot } from 'react-dom/client';
import { commentPrompt, createTemplateAgent, templateDefinition } from './agent.js';

const appId = 'local-only-template';
const principalScope = 'local-demo-principal';
const descriptor: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  languages: ['en'],
  features: ['streaming', 'cancellation'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
const mock = new MockChatModel({
  [commentPrompt]: { id: 'practice-comment', text: 'Keep practicing one small step at a time.' },
});
const registry = createRegistry({ components: [Quiz] });
const runtime = createRuntime({ appId, executors: [createLangGraphAdapter()] });
const instance = await runtime.create(templateDefinition, {
  principalScope,
  agent: createTemplateAgent(),
  // Omitting services.checkpointer selects the adapter's in-memory checkpointer.
  services: { chatModels: { mock } },
  models: {
    providers: { mock: descriptor },
    roles: {
      comment: { providers: ['mock'], allow: ['in-browser'], maxTokens: 48 },
    },
    availability: async () => ({ status: 'available' }),
  },
  bindings: {},
  ui: registry.bindings({ surfaces: ['question'] }),
});
const container = document.getElementById('root');
if (container === null) throw new Error('The application root is missing.');
const root = createRoot(container);
addEventListener('pagehide', () => { void runtime.dispose(); }, { once: true });

await instance.prepare();
const { runId } = await instance.start({});
root.render(
  <main>
    <p>Scripted mock; inference stays in this browser.</p>
    <ModelRoutes instance={instance} labels={{ providers: { mock: 'Mock' } }} />
    <AgentSurface instance={instance} registry={registry} surfaceId="question" />
  </main>,
);

for await (const event of instance.events(runId)) {
  if (event.type !== 'output' || typeof event.output !== 'object' || event.output === null)
    continue;
  const result = (event.output as Record<string, unknown>)['result'];
  if (typeof result === 'string') root.render(<main><p role="status">{result}</p></main>);
}
```

You gain a runnable question: choose **4**, submit, and see
`Correct. Keep practicing one small step at a time.` The graph pauses before the
model call; the surface dispatches the answer, and the router uses the scripted
mock. The template's [runtime tests](../../templates/local-only/test/runtime.node.test.ts)
and [app tests](../../templates/local-only/test/app.test.ts) cover mock completion
and the template's model states; they exercise the full template host.

Nothing survives a reload. There is no tab ownership and no application policy
beyond the fixed in-browser route. Core validation, destination controls and
finite budgets still apply. The host remains responsible for reviewed code,
lifecycle and deployment controls; replace the demo principal with trusted host
identity before adding user data. Add the next layers for persistence and the
host controls described in the reference.

## Layer 1: persist, recover, own

You gain durable pending interactions and accepted submissions by opening
`IndexedDBSaver` with the host's `appId` and trusted `principalScope`, then passing
both `services.checkpointer: saver` and `recovery: saver.recovery`. Keep the session
pointer under that same scope; after reload, prepare the instance with its saved
`sessionId` and call `instance.restore()`. Acquire tab ownership with the saver's
fencing port before restoring or writing, and dispose the runtime when ownership
is lost.

Follow [Storage persistence and recovery](#storage-persistence-and-recovery) and
[Ownership and logout](#ownership-and-logout), with the template's
[`src/runtime.ts`](../../templates/local-only/src/runtime.ts) and
[`src/app.tsx`](../../templates/local-only/src/app.tsx) as the wiring reference.
The [built-app reload test](../../templates/local-only/test/reload.node.test.ts),
[reopened IndexedDB app test](../../templates/local-only/test/app.test.ts) and
[ownership tests](../../tests/conformance/ownership.test.ts) cover those paths.
The host still owns trusted identity, session pointers, teardown and backend
reconciliation of unknown effects. Browser eviction can erase checkpoints;
unsubmitted drafts reset on reload, and ownership cannot stop an already-sent
remote request.

## Layer 2: harden

You gain controls for deployment, principal changes and significant actions.
Apply each control at its host boundary and keep its documented limits:

- [CSP and Trusted Types](#csp-and-trusted-types): restrict resource destinations
  and script sinks with response headers and reviewed policies; see the
  [CSP directive tests](../../examples/host-local/test/csp.test.ts) and
  [host-local CSP loop test](../../examples/host-local/test/loop.node.test.ts).
- [Cross-origin isolation](#cross-origin-isolation): enable COOP/COEP when the
  selected WASM multi-threaded path needs `SharedArrayBuffer`; the host must
  check that engine and its embeds, since the shipped WebGPU worker does not
  universally require isolation.
- [Model hosting and integrity](#model-hosting-and-integrity): pin reviewed assets
  and load after consent, respecting the weight-shard integrity limit; see the
  [fake WebLLM lifecycle tests](../../tests/conformance/webllm-provider.test.ts)
  and [ONNX file integrity tests](../../tests/conformance/transformers-model-files.test.ts).
- [Ownership and logout](#ownership-and-logout): wipe the principal before
  announcing invalidation and fence stale storage writes; see the
  [invalidation tests](../../tests/conformance/invalidation.test.ts) and
  [ownership tests](../../tests/conformance/ownership.test.ts).
- [Host confirmations](#host-confirmations): bind significant writes to
  single-use approvals of the exact parameters; see the
  [confirmation tests](../../tests/conformance/confirmations.test.ts).
- [Output safety and display](#output-safety-and-display): check routed model
  output and render trusted projections as text; see the
  [output safety tests](../../tests/conformance/output-safety.test.ts).
- [Session export](#storage-persistence-and-recovery): require an explicit host
  action and confirmation for personal content, then recheck ownership and logout;
  see the [storage export tests](../../packages/storage-indexeddb/test/export.test.ts)
  and [host-local download and failure tests](../../examples/host-local/test/loop.node.test.ts).

The host still deploys the headers, checks its chosen engines, authorizes backend
requests and enforces idempotency and spending limits. Same-origin code can bypass
SDK paths; output checks cannot retract earlier allowed chunks, and logout cannot
revoke a downloaded export. These linked tests use mocks, fakes and local browser
flows; they do not establish real-device model behavior or universal cross-origin
isolation. Keep the baseline and the limits in the reference sections below.

## CSP and Trusted Types

Send CSP as a response header. The worked example is
[host-local's directive map](../../examples/host-local/src/csp.ts), applied by
[its Vite configuration](../../examples/host-local/vite.config.ts).
The [model flow](../system-design.md#84-a-model-call) and
[baseline map](../system-design.md#9-security-baseline-map) explain its scope;
[brief §5.4](../galaxie-project-brief.md#54-host-integration-requirements-proposed)
lists the host requirements.

Start with `default-src 'none'`, same-origin scripts and workers, no inline script
or general JavaScript eval permission, and explicit connection/image/media/form/
frame allowlists. Set `base-uri 'none'`, `object-src 'none'` and a deliberate
`frame-ancestors` policy. `frame-ancestors` requires a header, not a meta tag.
Require Trusted Types for script sinks and allow only reviewed policy names.
Render model-produced props as React text, never `dangerouslySetInnerHTML`.

Mock host-local permits same-origin connections and no Trusted Types policies.
Default mode permits a `default` policy whose `createScriptURL` accepts only
the exact bundled worker URL; it grants no HTML or general script trust.
Host-local configures Zod with `jitless: true` before loading the app to avoid
its dynamic-function probe. See [policy and rendering](../../examples/host-local/README.md#policy-and-rendering)
and the current [host entry point](../../examples/host-local/src/main.tsx).
CSP still allows same-origin code to use allowed endpoints and does not
authorize URL paths or queries. Trusted component URL extractors must list
every URL used as a single attribute.

## Cross-origin isolation

COOP/COEP is an opt-in host choice when a selected WASM multi-threaded path
requires `SharedArrayBuffer`; it is not a universal requirement for the shipped
WebGPU worker. Cross-origin isolation can break third-party embeds. The
[runtime topology](../system-design.md#7-runtime-topology) separates the page
executor from inference; [brief §5.4](../galaxie-project-brief.md#54-host-integration-requirements-proposed)
defines this conditional requirement. The local example sets CSP, without
claiming cross-origin isolation for every engine.

## Model hosting and integrity

Follow [the provider contract](../system-design.md#84-a-model-call): host-bundle
a module worker that calls `startWebLLMWorker` from `@galaxie/models/webllm/worker`,
create it on the page and pass it to `loadWebLLMEngine`. Use one handle and worker
per runtime, dispose them on teardown, and load only after host-managed consent.
The library loads lazily; constructing the example's worker alone is inert.

Serve models and runtime assets from a reviewed origin, CDN or object store
with correct CORS. Use an immutable model revision and the validated record's
SRI values. The shipped record checks config, library and tokenizer integrity;
**weight shards are not SRI-checked**. Its record requires a 40-hex commit in the
weights URL. The page device report does not prove the worker used the same adapter.

Only the WebLLM worker needs download-host `connect-src` allowances and
`'wasm-unsafe-eval'` in `script-src`. Prefer per-path worker response headers
where the host supports them. The worked example shares one policy, allowing
`https://huggingface.co`, `https://*.hf.co` and `https://raw.githubusercontent.com`
in default mode. Those permissions also permit same-origin code to reach these
hosts; do not broaden them for unrelated integrations.

ONNX models through Transformers.js follow the same shape with a pinned record:
host-bundle a module worker that imports the ONNX Runtime WASM files as same-origin
asset URLs and calls `startTransformersWorker({ ort })` from
`@galaxie/models/transformers/worker`, create it through your Trusted Types worker
policy, and pass it with a `TransformersModelRecord` to `loadTransformersEngine`
after consent. Wire `checkTransformersModel` as the `availability` hook and have the
`download` hook load the engine with downloads allowed. Every file is checked
against the record's size and SHA-256 before it is stored, so a record is a
maintainer artifact: pin it with `scripts/pin-onnx-model.ts`, and treat real-model
quality as unmeasured. Only that Worker needs the model host in `connect-src` and
`'wasm-unsafe-eval'` in `script-src`; no galaxie-owned directive or policy changes.
See the [models README](../../packages/models/README.md#transformers-onnx-models).

Built-in AI runs on the page. Probe with `checkBuiltInAI`, and call
`prepareBuiltInAI` from an intentional download click. Calls require `available`
and never start a download themselves. The browser manages the model identity
and download; its size is not reported. Tell the user that explicitly rather
than estimating bytes. See [model coding guidance](../../packages/models/AGENTS.md).

## Storage persistence and recovery

Choose a content-free `appId` and derive `principalScope` from trusted host
session context. Both must be strings of 1 to 128 characters from
`A-Z a-z 0-9 . _ : -`; spaces, slashes, non-ASCII characters and non-strings
are invalid. Use the same pair for runtime, storage and cross-tab APIs.
`createRuntime` validates `appId` synchronously, and `runtime.create` rejects an
invalid `principalScope` before instance state or hooks. Both report fixed
`invalid` errors without echoing values. These checks match the existing
storage rule, so stored scopes remain readable; see the
[compatibility analysis](../system-design.md#6-core-runtime-and-contracts).

The [download hook](../system-design.md#84-a-model-call) supplies optional
`request.persist()` for `siteStorage: true`. Call it after user acceptance and
before downloading. It shares one `navigator.storage.persist()` result per
instance and resolves `false` when missing, rejected or cancelled. A denial
does not itself prevent downloading. Browser-managed downloads have no such hook.
`checkWebLLMModel` reports cached weights, not a loaded engine; the current host
must load WebLLM before prepare, with consent arranged before loading.

Persistence is not permanence: eviction can produce a fresh start. Compose
`IndexedDBSaver` with both `services.checkpointer: saver` and
`recovery: saver.recovery` for durable submissions and write receipts. Keep the
session key, saver and recovery port under the same app and trusted principal;
they hold private answers and tool outputs. Follow the
[recovery flow](../system-design.md#82-reload-and-crash-recovery) and
[storage README](../../packages/storage-indexeddb/README.md) for retention,
session deletion and compatible agent identity. Drafts remain local to components
and reset on reload. Unknown remote outcomes require backend reconciliation by
effect ID; recovery cannot finish arbitrary intermediate checkpoints without a
pending interrupt.

Bind `saver.exportSession(sessionId)` to an explicit metadata-summary action.
Call `saver.exportSession(sessionId, { personalContent: true })` only after the
user accepts a host-rendered confirmation explaining that the file contains
answers and lesson text. Cancel must export nothing. Keep the saver and session
ID in trusted host wiring, with no model-controlled export action. The
[host-local example](../../examples/host-local/README.md#session-export) supplies
both actions and disables them without a session or current ownership. It
rechecks ownership and logout after the asynchronous read, before downloading.
Export failures show fixed text without record content or raw host errors.

For a local download, serialize the frozen JSON export into an `application/json`
Blob, create an object URL, click a temporary anchor with `download`, then remove
the anchor and revoke the URL. This adds no HTML sink or Trusted Types policy and
needs no CSP relaxation in the tested Chromium flow. Treat personal exports as
personal data, including lesson text and capability results in checkpoints;
logout cannot revoke a returned copy or downloaded file. Exports are lossy and
provide no import, sync or cross-device recovery.

## User-device endpoints and Local Network Access

The [OpenAI-compatible model contract](../system-design.md#84-a-model-call)
accepts HTTPS base URLs or HTTP on exactly `localhost`, `127.0.0.1` or `[::1]`,
without URL credentials, query or fragment. Declare the final destination as
`user-device` or `user-endpoint` as appropriate. Every non-browser class needs
router permission, live-label permission and consent.

[Brief §5.4](../galaxie-project-brief.md#54-host-integration-requirements-proposed)
records Chrome's Local Network Access prompt from Chrome 142 for public-site
requests to loopback/LAN addresses. The endpoint also needs CORS for the exact
app origin; set `OLLAMA_ORIGINS` to that origin, never `*`, when using Ollama.
LAN permission does not replace the provider's URL validation or backend auth.
No real user endpoint or LNA prompt was exercised by this slice; the provider
maps status-less connection/CORS failures to fixed `unavailable/network` errors,
without determining the browser's exact cause. It does not silently fall back.

For `httpCapability`, a cross-origin server must allow `X-Galaxie-Agent` and
`X-Galaxie-Run` in `Access-Control-Allow-Headers`, plus `Idempotency-Key` when
the binding declares `retry: 'idempotency-key'`. Headers never authorize.
galaxie sets the key to `CapabilityContext.effectId` after the host's
`headers(context)` callback and attribution headers, overriding a host-supplied
key for that retry policy. Other retry policies leave host-supplied keys alone
and add none themselves.

For write bindings, the key stays stable across a replay only with recovery
and deterministic call order within each executor task. Without recovery,
each call receives a random effect ID. A successful receipt replays without
invoking the binding or sending a request. The backend must implement
deduplication; sending the header does not guarantee that the backend honors it.
A failed CORS preflight produces fixed `unreachable` for `user-device` or
loopback/private-address `user-endpoint`, and fixed `unavailable` for
`host-server`, `third-party` or public `user-endpoint`, without determining the
network failure's exact cause. Header evidence is injected-fetch and
Node/Chromium loopback only; real backend deduplication and real LNA permission
behavior remain unmeasured.

## Ownership and logout

Import both host lifecycle helpers from the opt-in browser entry:

```ts
import { acquireOwnership, watchInvalidation } from '@galaxie/core/browser';
```

Implement [ownership](../system-design.md#85-tab-ownership-and-takeover) before
local state writes. Open a principal-scoped saver, then call
`acquireOwnership({ appId, fence: saver.fencing, onHandoverRequest })`.
Use the same `appId` as the runtime. Handle `busy` without starting work; a
deliberate **Use here** action can retry with `takeover: true`. Dispose the runtime
in `onHandoverRequest`. The returned `ownership.signal` also requires host cleanup:
disable input, discard stale results and dispose on loss. Register the listener
and check `signal.aborted` so an already-lost owner cannot continue.

Only sweep, restore or write after acquisition completes its fencing claim.
On teardown, dispose the runtime before releasing ownership and closing storage.
Every saver state write checks the shared app epoch in its transaction. This
does not stop an already-sent remote request, a synchronous loop or a tab that
bypasses ownership; no backend epoch headers are sent by galaxie.

For [logout](../system-design.md#86-logout), create
`watchInvalidation({ appId, principalScope })` even before model preparation.
Await `saver.invalidatePrincipal()` before `watcher.announce()`; a failed wipe
must not announce success. A non-owner can invalidate. The transaction increments
the principal generation and wipes its data; old savers then refuse writes.
Reopen a saver for the new generation rather than reusing the invalidated one.
On local or peer invalidation, clear host session keys, tokens and displayed
data, disable input, dispose runtime/models and release ownership. Close the
watcher at teardown. Clear the host's own storage too; model assets are shared
and are not deleted by this API. Broadcast delivery can be delayed or missed;
transaction fencing and persisted `pageshow` checks provide the documented limits.

## Host confirmations

Use `approval: 'confirm'` for significant write bindings and configure
`CreateOptions.confirmations` with the full capability names, a current
`policyRevision`, expiry and both logout/ownership signals. Mount a separate
`ConfirmationPrompt` built with `defineConfirmations`, outside `AgentSurface`.
Use fixed host text and validated argument rows rendered as React text.
Follow [the capability flow](../system-design.md#83-a-capability-call) and
[React wiring](../../packages/react/README.md).

Missing configuration refuses dispatch. A single-use approval binds principal,
capability, frozen arguments, effect ID, policy revision and expiry. It stays
in page memory and is invalidated on run end, disposal and configured signals.
Hosts must still dispose on logout/takeover. Same-origin scripts can call
`respond`, and declining or expiring cannot undo a request already sent.
Every backend write still requires authentication, authorization and idempotency.
Only host-controlled MCP servers/gateways are supported; configure reviewed
metadata pins and close principal sessions on sign-out per
[the MCP contract](../system-design.md#61-mcp-client).

## Output safety and display

`RuntimeOptions.outputSafety` receives routed reply text and tool-call arguments
with `final`, `role`, `destination` and `signal`, and returns `'allow'` or `'block'`.
It runs before non-streaming return and before each growing streamed chunk,
with a final check. Blocks fail `denied`; hook failures fail closed with fixed
`unavailable` errors, without the hook error or a cause. See
[the model flow](../system-design.md#84-a-model-call).

The host owns the hook's treatment of that text, including any outbound use.
Earlier allowed chunks cannot be retracted. Direct models, tool/capability
results and other display callbacks are outside the hook. Omitting it reports
`output_safety_unset` once per routed instance. Host-local's sentinel blocker
demonstrates wiring, not a content classifier. Keep raw graph streams and
checkpoints away from display/telemetry; use trusted output projections and
the bound React registry. The tutor's raw streams can contain the answer key.

## Development warnings and diagnostics

Enable `RuntimeOptions.developmentWarnings` only during development, as
host-local does with `import.meta.env.DEV`. With the option absent, no checks or
extra availability probes run. The
[warning contract](../system-design.md#development-warnings) covers best-effort
page CSP/Trusted Types probes, optional bindings, role readiness,
provider-key-shaped storage values and blocked interaction URLs. Callbacks
receive codes and trusted identifiers, not storage values, URLs or model text.
They change no policy and cannot audit all effective headers. Enforced probes
produce expected console violations; a permissive default Trusted Types policy
is a documented false positive.

Keep `DiagnosticEvent.error` separate: it may hold private raw host/binding
error evidence and must never be forwarded where `private-user` data may not
go, or copied into public errors, events, snapshots or spans. Provider errors
are sanitized before reaching it; output-safety failures discard hook errors.
See [runtime contracts](../system-design.md#6-core-runtime-and-contracts) and
the [tracing guide](tracing.md).

## Google ADK agents

An app that offers `adk-js` agents owns three things in its entry code, because the adapter package cannot (a bundler drops side-effect-only imports from a package marked side-effect free):

- Put zod in jitless mode (`config({ jitless: true })` from `zod`) before the ADK bundle module is evaluated. Without it the bundle's own zod probes `new Function` and trips Trusted Types.
- Define `process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` as `"false"` in the build, so ADK's own spans never carry prompts, replies, arguments or results. In dev servers and test browsers that do not replace `process.env`, call `ensureAdkRuntimeEnv()` from `@galaxie/adapter-adk` first.
- To keep a conversation across reloads, pass `services.checkpoints` (the `byteRecords` port of `IndexedDBSaver`) with a recovery store, and compose ownership as for the other executors. The record holds the conversation and a per-session integrity key; session export never includes the key.

The bundle needs `crypto.subtle`, and ships under Apache-2.0 with inlined lodash (MIT) and `@google/genai` (Apache-2.0). See the [adapter README](../../packages/adapter-adk/README.md) and [unsupported list](../unsupported.md#google-adk-javascript).

## Remote models through a host proxy

Use the call-scoped factory exported by `@galaxie/models/openai`:

```ts
import { openAICompatible } from '@galaxie/models/openai';

const chatModels = {
  proxy: openAICompatible({
    baseURL: new URL('/model/v1', location.origin).href,
    model: 'host-model',
    maxTokens: 1024,
  }),
};
// Supply chatModels as services.chatModels when creating the instance.
```

The host must implement that endpoint; this example names no external model or
price. Configure matching `CreateOptions.models` descriptors, role routes,
consent and `getCredential({ role, providerId })` per
[the model contract](../system-design.md#84-a-model-call). Set `credential: true`.
Use `host-server` if the host is the final recipient, and `third-party` if its
proxy forwards externally. Display `snapshot.routes` and `changedFrom` notices.
Bind each credential to its fixed provider origin; never send a host-proxy token
to a URL supplied in user settings. Even local endpoints currently require a
non-empty bearer credential.

Issue short-lived scoped tokens from the host, never long-lived provider keys
in bundles or storage. Page code can read a credential during its call.
Backends authorize each operation and enforce spending limits; router token
reservations and cancellation do not enforce billing or guarantee the provider
stops. Cross-origin proxies also need the SDK's documented CORS header set.
[Host-remote](../../examples/host-remote/README.md) is a worked stub integration,
not a real upstream-provider result. Consult the [device matrix](../device-matrix.md)
for the tested scope.
