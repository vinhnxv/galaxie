# @galaxie/adapter-adk

Foundation for the Google ADK (JavaScript) executor adapter (executor id `adk-js`). Stage A1
ships no adapter yet: it pins ADK, proves that its browser bundle loads and runs under galaxie's
strict CSP and Trusted Types, and enforces the import rules. See
[ADR-0020](../../docs/adr/0020-google-adk-through-an-adapter.md) (Proposed).

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
