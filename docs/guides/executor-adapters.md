# Writing an executor adapter

An executor adapter translates a framework's native execution into the
[core executor contract](../../packages/core/src/executor.ts). The engine owns
its scheduler, state and checkpoint semantics; core owns instance/run lifecycle,
authorization, routing, budgets and public projection. The host supplies reviewed
agent code and services. This is trusted infrastructure, not an isolation boundary
for arbitrary code. See [ADR-0001](../adr/0001-langgraph-adapter-not-engine.md#decision)
and [ADR-0017](../adr/0017-framework-neutral-contracts.md#decision).

Use the checklist below when implementing or reviewing an adapter. It describes
the current contract, including optional paths, rather than requiring every
framework to support every feature. The [conformance suite](../../tests/conformance/README.md)
explains native-owned goldens, runtime-control tests and documented differences.
The concrete tests here use the existing LangGraph adapter as a worked example;
they are evidence for that implementation, not an automatic certification of a
new adapter.

## Adapter checklist

Each row names one obligation, its contract member, the existing proving coverage
and the governing decision. Source line links point to the corresponding member
in the current contract. Cancellation and disposal details are specified directly
there; ADR-0001 assigns lifecycle ownership to core.

| Obligation | Contract member | Conformance coverage | Governing rule |
| --- | --- | --- | --- |
| Keep framework types and engine execution in the adapter. Import core through its public API; never import another executor adapter. Shared helpers belong in adapter-kit only for the operations and import boundaries it defines. | [ExecutorAdapter](../../packages/core/src/executor.ts#L71) | [Dependency boundary tests](../../tests/conformance/check-dependencies.node.test.ts), exercising [the dependency checker](../../scripts/check-dependencies.ts) | [ADR-0017 decision](../adr/0017-framework-neutral-contracts.md#decision); [ADR-0026 import and publication contract](../adr/0026-adapter-kit-package.md#import-and-publication-contract) and [ownership](../adr/0026-adapter-kit-package.md#ownership) |
| Advertise a stable executor ID, the adapter version and only implemented feature flags. Unsupported shapes still need explicit refusals; a true flag is not a promise of every engine variant. | [ExecutorAdapter.id/version/features](../../packages/core/src/executor.ts#L72), [ExecutorFeatures](../../packages/core/src/executor.ts#L12) | [adapter.node.test.ts](../../tests/conformance/adapter.node.test.ts) (`advertises the adapter package version and only the implemented features`); [gate-replacement.test.ts](../../tests/conformance/gate-replacement.test.ts) | [ADR-0001 decision](../adr/0001-langgraph-adapter-not-engine.md#decision); [ADR-0017 decision](../adr/0017-framework-neutral-contracts.md#decision) |
| Validate the engine-specific agent and injected services in preparation. Reject malformed inputs with `invalid` and incompatible versions or features with `unsupported`. Accept routed model preparation through the supplied options, without executing a run during preparation. | [ExecutorAdapter.prepare](../../packages/core/src/executor.ts#L75) | [adapter.node.test.ts](../../tests/conformance/adapter.node.test.ts) (malformed services and missing native methods); [routing-services.test.ts](../../packages/adapter-langgraph/test/routing-services.test.ts); [runtime-guarantees.test.ts](../../tests/conformance/runtime-guarantees.test.ts) (preparation never executes another command) | [ADR-0001 decision](../adr/0001-langgraph-adapter-not-engine.md#decision); [ADR-0006 integration and routing](../adr/0006-model-providers-and-routing.md#decision) |
| Use core's run/session IDs and start/resume commands. Map the session to the engine's thread and the selected interaction to its native resume identity; preserve falsy submission values. Do not generate runtime IDs or a second scheduler. | [RunRequest.runId/sessionId/command](../../packages/core/src/executor.ts#L31), [RunCommand](../../packages/core/src/executor.ts#L21) | [adapter.node.test.ts](../../tests/conformance/adapter.node.test.ts) (one checkpointer thread; false submission); [galaxie.test.ts](../../tests/conformance/galaxie.test.ts) (native transcript comparison) | [ADR-0001 decision](../adr/0001-langgraph-adapter-not-engine.md#decision); [ADR-0004 decision](../adr/0004-interrupt-as-pending-interaction-source.md#decision) |
| Yield native stream data and framework-neutral interaction/output/error events through the async iterable. Core derives public run status. Preserve native semantics and record observed differences against a native reference instead of silently changing the engine. | [ExecutorAgent.run](../../packages/core/src/executor.ts#L56), [ExecutorEvent](../../packages/core/src/events.ts) | [galaxie.test.ts](../../tests/conformance/galaxie.test.ts), [native.node.test.ts](../../tests/conformance/native.node.test.ts), [compatibility matrix](../../tests/conformance/compatibility-matrix.json); [adapter.node.test.ts](../../tests/conformance/adapter.node.test.ts) (native chunks and final root state) | [ADR-0016 parity decision](../adr/0016-parity-demonstrations-and-otel-traces.md#decision); [ADR-0017 decision](../adr/0017-framework-neutral-contracts.md#decision) |
| Read one pending interaction from committed engine state, including after restore. Keep its identity stable across repeated reads and validate it before resume; return `undefined` when nothing is pending. Refuse pause shapes that cannot meet this rule. | [ExecutorAgent.pending](../../packages/core/src/executor.ts#L57), [RunCommand.resume](../../packages/core/src/executor.ts#L23) | [recovery.test.ts](../../tests/conformance/recovery.test.ts), [indexeddb.test.ts](../../tests/conformance/indexeddb.test.ts); [ID-less coverage](../../tests/conformance/README.md#id-less-interrupts) and [repeated-request coverage](../../tests/conformance/README.md#several-requests-in-one-node) | [ADR-0004 decision](../adr/0004-interrupt-as-pending-interaction-source.md#decision); [ADR-0030 decision](../adr/0030-several-engine-pauses-published-one-at-a-time.md#decision) |
| Register restored checkpoint JSON with `registerRestoredData` before returning it for validation or replaying it into code that can call outward. This hook is optional for direct hosts; an adapter path that needs it must fail closed when absent. | [RunRequest.registerRestoredData](../../packages/core/src/executor.ts#L43), [ExecutorAgent.pending options](../../packages/core/src/executor.ts#L60) | [repeated-requests.test.ts](../../packages/adapter-langgraph/test/repeated-requests.test.ts) and [idless.test.ts](../../packages/adapter-langgraph/test/idless.test.ts) (missing hook, registration before return); [interrupt-twice-recovery.test.ts](../../tests/conformance/interrupt-twice-recovery.test.ts) | [ADR-0030 restored-value rule](../adr/0030-several-engine-pauses-published-one-at-a-time.md#decision); [ADR-0014 sticky labels](../adr/0014-data-labels-and-argument-shapes.md#decision) |
| Forward cooperative cancellation to the engine and keep the run iterator alive until engine callbacks and checkpoint writes settle, including after abort. Core drains rather than calling the iterator's `return()` and alone bounds settlement waits; add no executor settlement timeout. Synchronous code cannot be preempted. | [RunRequest.signal](../../packages/core/src/executor.ts#L35), [ExecutorAgent.run settlement contract](../../packages/core/src/executor.ts#L51) | [adapter.node.test.ts](../../tests/conformance/adapter.node.test.ts) (`keeps a successor queued until abort callbacks and checkpoint writes settle without forking the thread`; `core alone bounds a never-settled predecessor and disposal at ten seconds`) | [ADR-0001 lifecycle ownership](../adr/0001-langgraph-adapter-not-engine.md#decision); [ADR-0012 finite budgets](../adr/0012-security-baseline.md#decision) |
| Send application tool calls through the run's capability port so broker validation, labels, confirmations and effect replay remain authoritative. Preserve the framework task scope when mapping recoverable effects; a native tool name or model answer never authorizes a write. | [RunRequest.capabilities](../../packages/core/src/executor.ts#L38), [CapabilityPort](../../packages/core/src/capabilities.ts) | [capabilities.test.ts](../../tests/conformance/capabilities.test.ts), [confirmations.test.ts](../../tests/conformance/confirmations.test.ts), [subgraph-effect-scopes.test.ts](../../tests/conformance/subgraph-effect-scopes.test.ts), [langgraph-tools.test.ts](../../tests/conformance/langgraph-tools.test.ts) | [ADR-0012 broker and confirmation rules](../adr/0012-security-baseline.md#decision); [ADR-0004 deterministic replay](../adr/0004-interrupt-as-pending-interaction-source.md#decision) |
| Authorize and reserve each model attempt through the run's model port. Use the selected implementation and call-scoped credential; check output before publishing chunks or final replies, then settle the lease with usage or failure. Forward requested features and repair attempts through routing. | [RunRequest.models](../../packages/core/src/executor.ts#L39), [ModelPort/ModelCall](../../packages/core/src/models.ts) | [models.test.ts](../../tests/conformance/models.test.ts), [output-safety.test.ts](../../tests/conformance/output-safety.test.ts), [structured-repair.test.ts](../../tests/conformance/structured-repair.test.ts), [credential-scan.test.ts](../../tests/conformance/credential-scan.test.ts) | [ADR-0006 routing, credentials and reservations](../adr/0006-model-providers-and-routing.md#decision); [ADR-0012 destination and credential rules](../adr/0012-security-baseline.md#decision) |
| Apply the supplied segment step limit at the native engine boundary. When a path serializes through the run payload boundary, use `payload`; decision adapters require it. Do not invent an unbudgeted serializer to replace a missing required boundary. | [RunRequest.limits](../../packages/core/src/executor.ts#L46), [RunRequest.payload](../../packages/core/src/executor.ts#L41) | [galaxie.test.ts](../../tests/conformance/galaxie.test.ts) (`step-limit` case); [runtime-guarantees.test.ts](../../tests/conformance/runtime-guarantees.test.ts); [decide.test.ts](../../packages/adapter-langgraph/test/decide.test.ts) (request before dispatch and answer before publication) | [ADR-0012 finite budgets](../adr/0012-security-baseline.md#decision); [ADR-0028 decision request limits](../adr/0028-decision-model-role.md#decision) |
| Instrument through the run's data-only trace recorder. Preserve parent handles and text opt-in; let core construct/filter spans and the host configure export. Keep credentials and raw error text out of public errors and instrumentation; raw diagnostics belong only to the host channel. | [RunRequest.trace](../../packages/core/src/executor.ts#L37), [RunTrace](../../packages/core/src/trace.ts), [ExecutorEvent.error](../../packages/core/src/events.ts) | [tracing.test.ts](../../tests/conformance/tracing.test.ts), [models.test.ts](../../tests/conformance/models.test.ts) (credential error canaries), [output-safety.test.ts](../../tests/conformance/output-safety.test.ts) (throwing hook text) | [ADR-0016 tracing decision](../adr/0016-parity-demonstrations-and-otel-traces.md#decision); [ADR-0012 allowlist and credentials](../adr/0012-security-baseline.md#decision) |
| Release resources the executor owns during disposal. Leave core's lifecycle and settlement bound intact; do not close host-owned shared services as though the adapter owned them. | [ExecutorAgent.dispose](../../packages/core/src/executor.ts#L62) | [adapter.node.test.ts](../../tests/conformance/adapter.node.test.ts) (bounded disposal); [shared-model-lifetime.test.ts](../../tests/conformance/shared-model-lifetime.test.ts) | [ADR-0001 ownership split](../adr/0001-langgraph-adapter-not-engine.md#decision); [ADR-0026 per-adapter ownership](../adr/0026-adapter-kit-package.md#ownership) |

## Checking the LangGraph implementation

The current reference implementation is
[`createLangGraphAdapter`](../../packages/adapter-langgraph/src/adapter.ts).
Its engine boundary uses native `transform()` because the pinned LangChain
`stream()` abort race can otherwise leave settlement unfinished. Its
[`LangGraphTraceHandler`](../../packages/adapter-langgraph/src/trace-handler.ts)
waits for the root callback; the adapter has no separate settlement timer.

The remaining mappings can be followed through
[`host.ts`](../../packages/adapter-langgraph/src/host.ts) for injected services
and broker-backed tools,
[`RoutedChatModel`](../../packages/adapter-langgraph/src/routed-chat-model.ts)
and [`routedDecision`](../../packages/adapter-langgraph/src/routed-decision.ts)
for model leases, output checks and decision payloads, and
[`ordinal.ts`](../../packages/adapter-langgraph/src/ordinal.ts) /
[`idless.ts`](../../packages/adapter-langgraph/src/idless.ts) for committed
pending state and restored-value registration.

The adapter's [author guidance and limits](../../packages/adapter-langgraph/README.md)
qualify its feature flags. In particular, parallel interrupts, repeated child
pauses, later-ordinal surfaces and repeated ID-less requests remain refused.
Explicit node config is needed across asynchronous work under the browser's
synchronous context shim; see the tested
[context rules](../../tests/conformance/README.md#explicit-config-and-context).

## Verification and limits

Run the existing tests without updating goldens:

```sh
pnpm exec vitest run --project node packages/adapter-langgraph/test tests/conformance/adapter.node.test.ts tests/conformance/check-docs.node.test.ts
pnpm test tests/conformance/galaxie.test.ts tests/conformance/recovery.test.ts tests/conformance/tracing.test.ts
pnpm run check:docs
pnpm check
```

The complete baseline and security-control mapping remains in
[system design §9](../system-design.md#9-security-baseline-map) and
[ADR-0012](../adr/0012-security-baseline.md). Its guarantees are unchanged.
The adapter does not replace host authorization, CSP, Trusted Types, reviewed
bundled agents or backend spending controls. Tests use scripted models and local
fixtures; this guide adds no live collector/backend, real-provider, device or
answer-quality measurement. A new adapter needs its own native and browser
conformance evidence for the features it advertises.
