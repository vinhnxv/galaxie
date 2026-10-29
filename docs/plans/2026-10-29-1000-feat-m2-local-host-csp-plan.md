---
title: M2 Local Example Host with CSP - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M2 Local Example Host with CSP - Plan

## Goal Capsule

- **Objective:** `examples/host-local` is a Vite app that runs the English tutor end to end in Chrome. It wires:
  - `createRuntime` and the LangGraph adapter;
  - the WebLLM and Built-in AI providers;
  - an output safety hook;
  - `packages/react` (registry, `AgentSurface` and the education components);
  - local bindings for `lessons.get@1` and `progress.save@1`.

  The app serves the Content-Security-Policy of brief §5.4. A Playwright test drives the whole lesson loop with the mock provider, records every request the page and its workers make, and shows that no request carries the learner's sentence. This is AT-04 on the SDK-controlled path.
- **Means:**
  - a private workspace package `@galaxie/example-host-local`, with no new external package versions;
  - a Vite `mock` mode for CI;
  - a Node-side Playwright test that builds the app, serves it with `vite preview` and drives Chromium through the `playwright` package already in the root devDependencies.
- **Authority, highest first:**
  1. `AGENTS.md` repository rules.
  2. Accepted ADRs in `docs/adr/`, in particular ADR-0006, ADR-0012, ADR-0014 and ADR-0016. Do not edit any ADR.
  3. This plan.
  4. `docs/galaxie-project-brief.md` §4.2, §4.3, §5.4 and AT-04.
  5. `docs/system-design.md` §8.4 (worker CSP directives and download hosts).
- **Execution profile:** autonomous, in Node and headless Chromium only, with no WebGPU adapter and no real `LanguageModel`. Work on the existing branch `m2/host-local` and open one pull request against `main`. Run the units in order, U1 to U5, and run `pnpm check` after each one.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - the CSP must be loosened beyond R3 for the app to work: `unsafe-inline` or `unsafe-eval` in `script-src`, a wildcard `connect-src`, or Trusted Types dropped;
  - an existing test assertion must change;
  - a conformance golden, the compatibility matrix or an ADR would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - the test would need to download model weights or call a real model;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges, never pushes to `main` and never enables auto-merge.

---

## Product Contract

### Summary

The host is the M2 slice's proof that a page can run the tutor with galaxie's controls on. It is also where the browser-level control, the CSP, meets the SDK-level controls: labels, routing and output safety. AT-04 needs evidence from the network itself, not from the router's decisions.

### Requirements

**Package**

- R1. `examples/host-local` is a private ESM package, `@galaxie/example-host-local`, with SPDX headers on every source file. It contains `index.html`, `vite.config.ts`, and under `src/`:
  - `main.tsx`;
  - `app.tsx`;
  - `runtime.ts`, which wires the runtime, the providers and the bindings;
  - `csp.ts`, which exports the policy as data;
  - `webllm-worker.ts`, which imports only `@galaxie/models/webllm/worker`.

  Dependencies:
  - `workspace:*` for `@galaxie/core`, `@galaxie/adapter-langgraph`, `@galaxie/models`, `@galaxie/react` and `@galaxie/example-english-tutor`;
  - the exact lockfile versions of `react` and `react-dom` (19.3.1), `@langchain/core` (1.2.20), `@langchain/langgraph` (1.5.1) and `zod` (4.6.7);
  - in `devDependencies`, `vite` 8.3.4 and `playwright` 1.64.1, already in the lockfile.

  The app uses Vite's built-in JSX transform, configured in `vite.config.ts`, and adds no React plugin. `vite.config.ts` sets `resolve.alias` for `@galaxie/core`, `@galaxie/adapter-langgraph`, `@galaxie/models/{mock,webllm,webllm/worker,builtin-ai}`, `@galaxie/react` and `@galaxie/example-english-tutor` to their `src` entry files, using the same map as `vitest.config.ts`. Neither the loop test nor the root build then depends on `dist/`, which does not exist yet when CI runs tests. The tutor package's `@mlc-ai/web-llm` peer is only needed in real mode. If the lockfile has it (`packages/models` devDependency), the host declares it at that same exact version; otherwise this is a stop condition.

**Runtime wiring**

- R2. `runtime.ts` exports a factory, with no module-level side effects, that takes the chat models and provider descriptors and returns the runtime. `main.tsx` imports `src/zod-config.ts` first. That module calls `config({ jitless: true })` from `zod`, and its comment says this avoids Zod's `new Function` probe under the strict CSP and Trusted Types. `main.tsx` then uses the literal `import.meta.env.MODE === 'mock'` to choose between dynamically importing `mock-script.ts` and building the real providers, so Vite removes the other branch at build time. The factory wires:
  - **Bindings:**
    - `lessons.get@1` returns `lessonFixture` for its ID and fails `not_found` otherwise;
    - `progress.save@1` writes to an in-memory map keyed by a learner ID that the host holds in a module constant (trusted host context). The ID never comes from capability arguments. The binding writes only for the fixture lesson.
  - **Checkpointer:** the in-memory default, on-device.
  - **UI bindings:** `createRegistry({ components: educationComponents }).bindings({ surfaces: ['lesson-main'] })`.
  - **Output safety hook:** a small host hook that blocks a reply containing a fixed demonstration marker string and allows everything else. Its comment states that it demonstrates the hook seam and is not a content filter.
  - **Provider mode:** chosen at build time from `import.meta.env.MODE`:
    - `mock`: both roles route to the mock provider, declared as `in-browser`. Its scripted structured replies (a three-question quiz and a review) are kept in a `mock-script.ts` module, which is imported only in that mode. `mock-script.ts` exports the sentinel sentence as a constant, `Galaxie sentinel 7f3e she walk to school`. The review reply is keyed on `JSON.stringify({ rubric, grammarPoint, sentence })`, built from `lessonFixture` and that constant, in the same way as `examples/english-tutor/test/support.ts`. The loop test imports the constant.
    - default: both roles route to Built-in AI first and WebLLM second, both declared `in-browser`, following the ADR-0006 order. The router's existing availability and download hooks are used. `WebLLMChatModel` needs a loaded engine handle, so in default mode the instance is created only after the "Prepare models" click. The click calls `prepareBuiltInAI` and loads WebLLM, through the cached or downloaded weights. It then constructs the chat models and the runtime; until then the Start button is disabled. A lazy chat-model wrapper is out of scope. Any other provider-preparation UI is out of scope. The WebLLM worker is created with `new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module' })`.

  The app never includes a provider key, a token or a remote endpoint.

**CSP**

- R3. `csp.ts` exports the directive map. In mock mode, `connect-src` is `'self'` only. In default mode it is exactly `'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com`: the origins of `defaultWebLLMModel`'s URLs plus the Hugging Face redirect host pattern from system design §8.4. The stop condition's "wildcard" means a bare `*` or a scheme-only source, not this host pattern. `trusted-types` is `'none'` in mock mode. In default mode it is `default`, and `src/trusted-types.ts` creates a `default` policy with only `createScriptURL`, which accepts only the same-origin bundled WebLLM worker URL and throws for everything else. Under `require-trusted-types-for 'script'`, `new Worker(url)` needs a `TrustedScriptURL`, so this policy is required (R6 documents it). Directive list:

  ```text
  default-src 'none'
  script-src 'self' 'wasm-unsafe-eval'
  worker-src 'self'
  connect-src <per mode>
  style-src 'self'
  img-src 'self'
  font-src 'self'
  media-src 'none'
  form-action 'none'
  frame-src 'none'
  frame-ancestors 'none'
  base-uri 'none'
  object-src 'none'
  manifest-src 'self'
  require-trusted-types-for 'script'
  trusted-types <'none' in mock mode, default in default mode>
  ```

  `vite.config.ts` sends the policy as a response header for both `server` and `preview`, built from `csp.ts`. A `<meta>` tag cannot carry `frame-ancestors`. Inline styles are not needed; if React or Vite needs one, this is a stop condition, not a reason to add `'unsafe-inline'`.

**App**

- R4. `app.tsx` shows:
  - a Start button that creates the instance with input `{ lessonId: lessonFixture.id }`;
  - `AgentSurface` on `lesson-main`;
  - a status line from `useAgentSnapshot`, showing run status and the projected output score.

  The host renders only snapshot fields and interaction props. It never renders raw `stream` events, as the AGENTS.md project status requires. It uses semantic elements and labels, so the test can find controls by accessible role and name.

**Test**

- R5. `examples/host-local/test/loop.node.test.ts`, run by the Node Vitest project:
  1. Build with Vite's JavaScript API in `mock` mode into a temporary directory. Set `process.env.NODE_ENV = 'production'` for the duration of the `build()` call and restore it afterwards, so the test drives the production bundle.
  2. Start `preview` on `127.0.0.1` with an ephemeral port.
  3. Launch Chromium through `playwright`.
  4. Use `context.route('**/*')` to record every request from the page and its workers and to continue it. Any request whose origin is not the preview origin is aborted and recorded.
  5. Drive the lesson: start, answer the quiz with one wrong answer, submit, type a sentinel sentence such as `Galaxie sentinel 7f3e she walk to school`, submit, continue past Feedback, then continue past Progress.

  The test asserts:
  - **Outcome:** the run succeeds and the status shows the projected score.
  - **No sentence on the network:** no recorded request's URL, headers or post data contains the sentinel or any distinctive word span of it.
  - **No other origins:** every request's origin is the preview origin, and every method is `GET`.
  - **CSP header:** the document response's `content-security-policy` header equals the policy built from `csp.ts` for mock mode.
  - **CSP enforced:** in-page `fetch('https://example.com/')` rejects, and a `securitypolicyviolation` event with `connect-src` fires. Probe `eval` through `context.newCDPSession(page)` and `Runtime.evaluate` with `allowUnsafeEvalBlockedByCSP: false`; the result must be an `EvalError`. `page.evaluate` bypasses CSP for eval, so it is not used for this probe. Assigning a string to `innerHTML` throws a Trusted Types `TypeError`.
  - **Clean console:** the page has no uncaught errors, and no CSP violation other than the deliberate probes.

  A second case builds and serves **default mode** the same way. Before any click, it asserts that the page loads with no CSP violation and no uncaught error. Then, from page code, it constructs the WebLLM worker through the app's exported worker factory, with no WebGPU and no download, and asserts that the constructor succeeds under the default-mode policy. Every request stays same-origin.

  The test closes the browser and the server in `afterAll`. It skips nothing in CI.

**Docs**

- R6. `examples/host-local/README.md` covers:
  - how to run mock mode and default mode;
  - what the CSP allows and why;
  - what the test proves, and its limits:
    - only the SDK-controlled path;
    - same-origin code can still use allowed endpoints (brief §5.4);
    - the browser's own Built-in AI download traffic is outside the page;
    - real-device runs are the exit slice's work;
    - artifact integrity is unchanged from `defaultWebLLMModel`: config, library and tokenizer are pinned to commits and checked with SRI, but weight shards are not hash-checked (system design §8.4). The README states this gap and does not claim more.

  The AGENTS.md project status and README status gain one sentence each. System design §8.4 points to the example's CSP.

### Scope Boundaries

- **Deferred to the real-device exit slice:** real-device runs, real model downloads, performance figures.
- **Deferred to M3:** reload restore and draft persistence.
- **Not in M2:** remote providers, user endpoints and MCP.
- **Not in this slice:** a general download-consent UI beyond the single "Prepare models" button, and a production build or hosting setup.

### Assumptions

- Chromium from `pnpm exec playwright install --only-shell chromium`, which CI already runs, is enough for the `playwright` launch.
- Vite 8.3.4 compiles TSX with the automatic runtime without a plugin.
- Playwright's context routing sees requests from dedicated workers in Chromium. If it does not, the test also listens to `page.on('worker')` and records through CDP `Network` on each worker target.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The Playwright test runs in Node.** It uses the `playwright` package directly inside the Node Vitest project, not `@playwright/test`. This needs no new dependency, and CI already installs the browser.
- KTD2. **A Vite mode, not a runtime flag, selects mock providers.** The mock script never ships in a default-mode bundle, and the page has no switch that downgrades routing.
- KTD3. **The CSP is data in one module.** The header and the test both use it, so they cannot drift.
- KTD4. **Network evidence, not router evidence.** The test records the wire, because AT-04 is about what leaves the browser.

### Output Structure

- `examples/host-local/{package.json,tsconfig.json,index.html,vite.config.ts,README.md,src/*.ts,src/*.tsx,test/csp.test.ts,test/runtime.test.ts,test/loop.node.test.ts,test/tsconfig.json}`.
- Root `package.json` (the typecheck and typecheck:ts6 scripts, plus a `build` step that runs `vite build` for the host).
- `vitest.config.ts`: the Node project already matches `examples/*/test/**/*.test.ts`. Add a per-file timeout for the loop test if needed.
- `scripts/check-dependencies.ts`: an import allowlist for `examples/host-local/src`. `@galaxie/models/mock` is allowed only in `mock-script.ts` and the module that imports it under the mode check.
- `scripts/check-license.ts` and `biome.json`, only if they need the new files.
- `pnpm-lock.yaml`.
- Docs.

The tree is a scope declaration; the per-unit file lists are authoritative.

### Implementation Constraints

- Strict compiler settings (system design §10). Relative imports end in `.js`, type-only imports use `import type`, and exported functions declare return types.
- The host's source never calls `fetch` itself. It does not use `dangerouslySetInnerHTML`, never renders `stream` events, and holds no secrets.

---

## Implementation Units

### U1. Scaffold and CSP

- **Files:** `examples/host-local/package.json`, `tsconfig.json`, `test/tsconfig.json`, `index.html`, `vite.config.ts`, `src/csp.ts`, `test/csp.test.ts`, `src/main.tsx` (a placeholder at first), root `package.json`, `pnpm-lock.yaml`, `scripts/check-dependencies.ts`.
- **Test scenarios:**
  - `csp.ts` unit tests:
    - mock mode has `connect-src 'self'` only and `trusted-types 'none'`;
    - default mode has exactly `'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com` and `trusted-types default`;
    - every default-mode `connect-src` origin covers the origins of `defaultWebLLMModel`'s URLs.
  - No directive contains `unsafe-inline` or `unsafe-eval`.
  - `require-trusted-types-for 'script'` is present.

### U2. Runtime wiring

- **Files:** `src/runtime.ts`, `src/mock-script.ts`, `src/webllm-worker.ts`, `src/trusted-types.ts`, `src/zod-config.ts`, `test/runtime.test.ts`. `test/runtime.test.ts` calls the factory directly with mock models, so `import.meta.env.MODE` plays no part. It must run on both Node and Chromium, or be named `runtime.node.test.ts` and run on Node only.
- **Test scenarios** (Node, mock mode, without React):
  - The bindings satisfy `BindingsFor<typeof tutorDefinition>`.
  - `progress.save@1` stores the score under the host learner ID, and rejects any other lesson ID.
  - The safety hook blocks the marker and allows other text.
  - **Default-mode smoke:** build the default-mode runtime with a fake `LanguageModel` global that reports `available`, using the pattern in the `packages/models` Built-in AI tests, and a WebLLM handle that is never loaded. Assert that one tutor run goes through `quiz.generate` and `tutor.feedback` on the Built-in AI provider to a successful projected output, with no network and no worker start. Restore the global afterwards.

### U3. App

- **Files:** `src/app.tsx`, `src/main.tsx`.
- **Approach:** R4. Keep it small and accessible.

### U4. Playwright loop test

- **Files:** `test/loop.node.test.ts`, and `vitest.config.ts` if a timeout is needed.
- **Test scenarios:** all R5 assertions. As a negative control, add a request inside the test, from page code, whose URL carries the sentinel. Assert that the recorder flags it, then exclude it from the final assertion. This shows the recorder can see a leak.

### U5. Documentation

- **Files:** `examples/host-local/README.md`, `AGENTS.md`, `README.md`, `docs/system-design.md`.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | U2 and later, and before the PR |
| Host build | `pnpm --filter @galaxie/example-host-local exec vite build` in default mode | U3 and later |
| M1/M2 behavior kept | every pre-existing test passes with unchanged assertions | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty | before the PR |
| Dependencies | the lockfile diff adds only the new importer and snapshot variants of versions already present; `pnpm install --frozen-lockfile` passes | U1, before the PR |

## Definition of Done

- U1 to U5 are complete, and each unit's tests pass.
- The loop test shows that the sentinel sentence is absent from every request, that the page talks only to its own origin, and that the CSP header is present and enforced.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.
- The PR body lists the limits of R6 and the Scope Boundaries.

## Appendix

### Sources

- Brief §4.2, §4.3, §5.4 and AT-04; ADR-0006, ADR-0012 and ADR-0016.
- `examples/english-tutor/src/*` (definition, graph, lesson fixture) and `examples/english-tutor/test/support.ts` (mock scripting).
- `packages/models/src/webllm/{index.ts,worker.ts,model-record.ts}` and `packages/models/src/builtin-ai/{index.ts,api.ts}`.
- `packages/react/src/*` (registry, `AgentSurface`, components).
- `.github/workflows/ci.yml` (Chromium install), `vitest.config.ts` and `scripts/check-dependencies.ts`.
