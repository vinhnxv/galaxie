# @galaxie-ai/core: coding guidance

## Purpose

Own framework-neutral contracts and the host runtime: lifecycle, budgets,
capability grants, model routing, interactions, recovery and filtered spans.
See the [README](README.md) and [runtime contracts](../../docs/system-design.md#6-core-runtime-and-contracts).

Core's only direct dependency is `@galaxie-ai/ui-protocol`; import its public root only.
Core owns catalog binding, publication/restore validation, revisions and private-user
provenance for materialized pending surfaces. Legacy requests retain their old path.

## Entry points

- `@galaxie-ai/core` exports the runtime and contracts from [src/index.ts](src/index.ts),
  with no unguarded browser globals.
- `@galaxie-ai/core/browser` opts into ownership and invalidation helpers and their
  types from [src/browser.ts](src/browser.ts).
- `createRuntime`, `defineAgentDefinition` and `createManifest` construct runtime,
  definition and build-time manifest data respectively.
- `httpCapability` and `galaxieField` support host bindings and schema annotations
  through the main entry. Import `acquireOwnership` and `watchInvalidation` from
  `@galaxie-ai/core/browser` for host lifecycle wiring.
- `RuntimeOptions`, `CreateOptions`, `AgentInstance`, `RecoveryStore` and
  `DiagnosticEvent` are exported contracts; internal modules are not subpaths.

## Do

Create the runtime in trusted host code and register a real adapter:

```ts
import { createRuntime } from '@galaxie-ai/core';
import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';

const runtime = createRuntime({
  appId: 'lesson-app',
  executors: [createLangGraphAdapter()],
});
```

- Supply narrow versioned capability bindings and validate inputs and outputs.
- Use `galaxieField` annotations for labels; labels come from trusted schemas.
- Pass `recovery` alongside the same principal-scoped checkpointer when durable
  submission acceptance and write replay are required.
- Recovery write IDs use the session, executor task scope, capability name and
  per-scope call order. Keep call order within each task deterministic; a later
  task receives new IDs. Calls without a task scope retain segment-based IDs,
  so repeated unscoped starts require a fresh session for a new operation.
- Dispose instances on logout and ownership loss; compose ownership explicitly.
- Keep errors fixed and content-free; keep raw `DiagnosticEvent.error` host-only
  and never forward it where `private-user` data may not go.
- Opt into routed structured-output repair per role with `ModelRoute.repairAttempts`
  (default `0`). Core validates the one-based claim before routing side effects and
  consumes the shared run repair budget (default `2`) before ordinary selection.

## Never

- Never add generic fetch, SQL or shell capabilities, or use attribution as authorization.
- Never place credentials in graph state, checkpoints, errors, events or traces.
- Never assume direct model calls inherit router policy or output safety.
- Never export raw host errors or set a cause on new typed errors.
- Never render raw executor stream state as display data.

## Limits

Trusted bundled agent code and same-origin scripts can bypass SDK paths.
Token limits are reservations; actual overruns are detected after a call.
Repair calls also reserve tokens and cost and recheck labels, consent and output
safety; they charge neither graph steps nor capability calls. A route may reselect
a different provider for repair. Direct provider calls do not inherit repair.
Recovery cannot reconcile an unknown remote outcome automatically.
Span text is off by default; the development opt-in follows live labels and
the declared final destination. See [the baseline](../../docs/adr/0012-security-baseline.md).

## Tests

Unit tests live in [test/](test/); cross-platform controls and parity live in
[tests/conformance/](../../tests/conformance/README.md).
From the repository root, run `pnpm exec vitest run --project node packages/core/test`
and `pnpm test tests/conformance`. Use mock providers only; run `pnpm check`
before reporting completion.
