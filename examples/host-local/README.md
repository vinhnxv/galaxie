# Local English tutor host

`@galaxie/example-host-local` is a private Vite example that runs the reusable English tutor in the page, with local capability bindings, the education component registry and an output safety hook. It has no agent backend, remote endpoint, provider key or tracing exporter.

Use Node.js 24 and pnpm 11 from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @galaxie/example-host-local exec vite build --mode mock
pnpm --filter @galaxie/example-host-local exec vite preview --mode mock --host 127.0.0.1
```

Open the printed local URL, select **Start**, answer the three questions, submit a sentence and continue through Feedback and Progress. Mock mode recognizes this exact sentence for its scripted review:

```text
Galaxie sentinel 7f3e she walk to school
```

For default mode, rebuild and serve with the same mode:

```sh
pnpm --filter @galaxie/example-host-local exec vite build
pnpm --filter @galaxie/example-host-local exec vite preview --host 127.0.0.1
```

Default mode contains no mock script. **Prepare models** is the intentional download click; Start stays disabled until WebLLM is loaded and the host exists. Preparation attempts Built-in AI and then loads WebLLM in a bundled module worker. A missing Built-in AI API permits the WebLLM route. Both roles prefer available Built-in AI, then WebLLM, through the router's availability and download hooks. A failed preparation shows a fixed message and permits another preparation attempt. WebLLM needs a suitable WebGPU device; this path has not been verified with real models or devices.

WebLLM's declared weight size is 868,547,584 bytes. The browser manages the Built-in AI download and does not report its size. This single preparation button is the extent of the download UI; a general consent interface is outside this slice.

## Policy and rendering

[src/csp.ts](src/csp.ts) owns the directive map. Vite sends it as a `Content-Security-Policy` response header in both development and preview, including `frame-ancestors 'none'`, which cannot be enforced by a meta tag. The tested path uses production bundles and preview; no production hosting setup is provided.

Mock mode allows only `'self'` for connections and sets `trusted-types 'none'`. Default mode adds exactly `https://huggingface.co`, `https://*.hf.co` and `https://raw.githubusercontent.com` for the pinned WebLLM assets and Hugging Face redirects. Workers and scripts stay same-origin. The script policy includes `'wasm-unsafe-eval'` for WebLLM, with no inline scripts, inline styles or general JavaScript eval permission. Other directives deny frames, forms, media, objects and base URLs; styles, images, fonts and manifests are same-origin only.

Both modes require Trusted Types for script sinks. Default mode permits only the `default` policy: its sole `createScriptURL` rule accepts the exact same-origin bundled WebLLM worker URL. It supplies neither HTML nor general script trust. Constructing the worker is inert; its WebLLM import waits for the first engine message and buffers startup messages in order. Zod is configured with `jitless: true` before dynamically loading the app and runtime, avoiding its `new Function` probe under this policy.

Model-produced props render through `AgentSurface` and the education components as React text. The host reads run status from `useAgentSnapshot` and validates the projected `output` event for the final score; the current runtime does not populate `snapshot.view`. It never displays raw `stream` events, which can include the sentence and answer key. The output safety hook blocks `GALAXIE_BLOCK_DEMO` to demonstrate the hook seam; it is not a content filter.

Only `import.meta.env.DEV` enables core's `developmentWarnings`, logging `console.warn('[galaxie]', warning.code, warning.name ?? '', warning.area ?? '')`. Production builds and preview pages, including the loop test, omit the option and run no warning checks. The [six warning codes and limits](../../docs/system-design.md#development-warnings) cover page enforcement, optional bindings, role readiness, provider-key-shaped storage values and rejected URLs; logs contain no storage keys/values, URLs, credentials or model text. These warnings are best-effort advice, not controls.

In development, the enforced CSP and Trusted Types policy produce one expected blocked-eval and one Trusted Types console violation per runtime creation; the blocked probes emit no warning. A configured reporting endpoint also receives browser reports. A report-only policy reports without blocking and can still produce warnings. A pass-through default `createHTML` policy is a known Trusted Types false positive; this host's default policy does not provide `createHTML`. Core cannot inspect response headers or audit all directives. Its HTML probe uses a discarded detached template, and its eval probe compiles only a constant body.

The in-memory checkpointer stays on-device and belongs to the host's fixed demo learner and session. The local progress binding authorizes only the fixture lesson and stores `{ lessonId, score, total }` under a learner ID held by the host, never supplied by the agent. Scores are practice data, with no server authority. State and drafts disappear on reload; reload restore and draft persistence belong to M3.

## Evidence and limits

Run the Node-side Playwright loop and the full gates from the repository root:

```sh
pnpm exec vitest run --project node examples/host-local/test/loop.node.test.ts
pnpm check
CI=true pnpm test
```

The loop builds production bundles in mock and default modes in temporary directories, serves each on an ephemeral loopback port, and drives headless Chromium. It records URLs, headers and post data through context routing, aborting other origins. The mock lesson finishes with one wrong answer and a projected score of 2/3. No request carries the sentinel or its distinctive word spans, and every observed request is a same-origin GET. Requests deliberately sent from page code and from the inert worker prove that the recorder detects a leak before those controls are excluded from the lesson evidence.

The test compares the document header with the shared policy, checks that an external fetch rejects with a `connect-src` violation, probes eval through CDP with CSP bypass disabled, and verifies that string assignment to `innerHTML` throws a Trusted Types error. It rejects uncaught errors and unexpected CSP violations. The default-mode case checks initial load and the exported worker factory without a WebGPU adapter, a real `LanguageModel`, an engine message or a model download; it verifies that context routing sees worker traffic and that the real WebLLM bundle is never requested. Once the default policy is installed, other same-origin and cross-origin worker URLs and string HTML are rejected. A separate runtime smoke uses fake Built-in AI for both roles, restoring any prior global descriptor afterwards. A Node entry-point test with fake resources preserves a cached document on persisted `pagehide` and verifies disposal on a later discarded-document transition; actual browser-cache restoration with real models remains unmeasured.

This evidence covers only the SDK-controlled path and these mock/fake runs. Same-origin code can still use endpoints allowed by the CSP, including the download hosts in default mode; CSP does not authorize URL paths or queries. The browser's own Built-in AI download traffic occurs outside the page and is outside this capture. Real-device runs, real downloads and performance figures remain M2 exit work. Remote providers, user endpoints and MCP are outside this slice.

Artifact integrity is unchanged from `defaultWebLLMModel`: config, library and tokenizer use commit-pinned URLs and SRI, but weight shards are not hash-checked. An immutable weight revision does not close that gap. See [system design §8.4](../../docs/system-design.md#84-a-model-call).
