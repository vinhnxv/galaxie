# @galaxie/adapter-adk: coding guidance

## Purpose

Host Google ADK (JavaScript) agents as a galaxie executor, with routing, labels, consent,
budgets and persistence kept in galaxie. Stage A3 adds checked streaming. See the
[README](README.md) and [ADR-0020](../../docs/adr/0020-google-adk-through-an-adapter.md).

## Entry points

- [src/index.ts](src/index.ts) exports `createAdkAdapter`, the host types and the executor id.
- [src/adapter.ts](src/adapter.ts) is the `adk-js` adapter and its Runner-owning run loop.
- [src/llm.ts](src/llm.ts) is the router-backed `GalaxieLlm`; [src/host.ts](src/host.ts) builds the
  host, capability tools and trust registry; [src/validate.ts](src/validate.ts) checks the agent tree.
- [src/session.ts](src/session.ts) is the in-memory session service; [src/run.ts](src/run.ts) holds
  the per-run failure slot.
- [src/runtime-shim.ts](src/runtime-shim.ts) makes the bundle's unguarded `process.env` read safe.
- [test/bundle-probe.ts](test/bundle-probe.ts) is the probe every lane runs.
- [test/support/bundle-csp](test/support/bundle-csp) holds the pages the strict-CSP test builds.

## Do

- Import `@google/adk` through the root specifier only; the `browser` condition selects the web bundle.
- Import `@google/genai` as a type only; the bundle inlines its own copy.
- Keep zod jitless, the tracer provider and the content-capture define ahead of the bundle in host entries.
- Keep framework output content-free.

## Never

Do not import an `@google/adk/...` subpath, another executor adapter or LangGraph. Do not name ADK in
`packages/core`. Do not relax CSP or Trusted Types, add `unsafe-eval`, or let a run reach the network.
`scripts/check-dependencies.ts` enforces the import rules.

## Limits

The adapter streams checked text deltas and content-free tool markers, but has no interrupts,
resume, checkpoints or subgraphs, and sessions live in memory. The bundle is pinned by SHA-256. Span content capture defaults to on inside the bundle, so
hosts must apply the build define.

## Tests

Run `pnpm exec vitest run packages/adapter-adk tests/conformance/adk.test.ts
tests/conformance/adk-native.node.test.ts`. The bundle-file test fails on any ADK or bundle change.
Run `pnpm check` before reporting the integrated change as finished.
