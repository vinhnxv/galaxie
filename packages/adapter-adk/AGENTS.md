# @galaxie-ai/adapter-adk: coding guidance

## Purpose

Host Google ADK (JavaScript) agents as a galaxie executor, with routing, labels, consent,
budgets and persistence kept in galaxie. Durable sessions go through the byte-record checkpoint port. A pause is accepted only where ADK's resume does not rerun earlier siblings (`restartsSiblings` in `src/adapter.ts`, evidence in `test/agents.test.ts`); the admission-capable last-child rerun remains REFUSED after a second-write scope mismatch and early long-running invocation, so loosening that rule still needs new evidence. See the
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

The adapter streams checked text deltas and content-free tool markers and pauses on confirmations
and long-running tools (interrupts and resume), and stores sessions through `services.checkpoints`
when the host supplies it (otherwise in memory). It has no subgraphs. Any repeated agent name, including the root, fails `unsupported` at prepare before model or store access; names compare exactly.
Live and stored pauses use one `pauseAuthor` derivation and share `pauseAdmitted`;
confirmation-request and gated-call events need one defined, agreeing author, and restore
rejects missing, disagreeing or refused authors before registration or loading (`unrecoverable`).
Invalid older pauses with missing or differing gated authors now fail closed; the unchanged
format keeps ordinary author-unified records readable by older adapters. Any defined
`actions.agentState` or `actions.endOfAgent` is refused on encode (`unsupported`) and restore
(`unrecoverable`), without changing the format. The integrity key lives in
record metadata and must never be logged, put in a span or error, or exported. Author code sees positional requests only; never expose ADK call IDs. The bundle is pinned by SHA-256. Span content capture defaults to on inside the bundle, so
hosts must apply the build define.

`defineAdkEntry({ agent, roleStrings: true })` admits exact declared-role strings
through a host-owned tree. Admission checks exact classes first, reads own data
descriptors, copies arrays without author species or iterators, and never writes
to author objects. Repeated and concurrent prepares can reuse string trees; agent
object identity is not preserved. Without the opt-in, strings stay refused. Trees
without strings keep their original execution path. Explicit `host.adk.llm(role)`
models still belong to their preparation and need fresh factory-built trees.

The exported `adkToolset(host, tools)` groups a fixed, frozen copy of same-host
capability tools without adding a host key. Empty, nested, foreign, control-tool
and duplicate-name groups refuse, including collisions with flat tools or other
groups. Keep the request-time model trust check and existing pause-position rules.
Native author-defined and dynamic toolsets, provider tools, planners and executors
remain refused. ADR-0012 and stored formats are unchanged.

## Tests

Run `pnpm exec vitest run packages/adapter-adk tests/conformance/adk.test.ts
tests/conformance/adk-native.node.test.ts tests/conformance/adk-restore.test.ts`. `test/persist.test.ts` covers the record codec; `adk-restore.test.ts` covers reload, replay, rollback and tampering. The bundle-file test fails on any ADK or bundle change.
Run `pnpm check` before reporting the integrated change as finished.
The pause-author, restore-admission and new last-child measurement files have scripted Node/Chromium
and local Firefox/WebKit evidence; the older native L1-L5 file is cited from Node/Chromium only.
The five role-string/toolset files and JavaScript golden suite also pass locally
on Firefox and WebKit (104 tests per engine); the integrated Node/Chromium ADK
selection passes 974 tests, with seven skipped.
Real models remain unmeasured, and the retained last-child suite pins shipped refusals.
