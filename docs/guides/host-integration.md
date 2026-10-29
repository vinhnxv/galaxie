# Host integration

The host owns authentication, backend authorization, rendering, model preparation
and runtime teardown. galaxie constrains SDK-controlled paths; reviewed agents,
XSS and other same-origin code can bypass those paths. Read the
[mandatory baseline](../adr/0012-security-baseline.md),
[security review](../security-review.md) and [package guidance](../../llms.txt)
alongside these integration steps. Packages are currently private workspace packages.

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

Built-in AI runs on the page. Probe with `checkBuiltInAI`, and call
`prepareBuiltInAI` from an intentional download click. Calls require `available`
and never start a download themselves. The browser manages the model identity
and download; its size is not reported. Tell the user that explicitly rather
than estimating bytes. See [model coding guidance](../../packages/models/AGENTS.md).

## Storage persistence and recovery

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

## Ownership and logout

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
