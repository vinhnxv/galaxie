---
title: M1 Capability Broker, Data Labels, Budgets and Capability Spans - Plan
type: feat
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M1 Capability Broker, Data Labels, Budgets and Capability Spans - Plan

## Goal Capsule

- **Objective:** A host developer can give a LangGraph agent running in galaxie access to the app's own APIs one capability at a time. A call runs only when the host bound and granted it. Its arguments and results are validated. Private text cannot leave through a free-text argument to a destination the run's data labels forbid. Every call is limited by finite budgets, attributed to the agent and run, and visible as an allowlisted span. This holds on Node and in headless Chromium.
- **Means:** a per-instance capability broker in `packages/core` behind a framework-neutral executor port (KTD1, KTD2). Labels and argument shapes are read from Zod metadata through Standard JSON Schema (KTD3 to KTD6). `httpCapability` is the only network path the broker makes (KTD7). Run budgets are enforced by core, and the step limit by LangGraph's own `recursionLimit` (KTD8). Capability spans are recorded through the existing tracing module (KTD9).
- **Authority, highest first:**
  1. `AGENTS.md` repository rules.
  2. Accepted ADRs in `docs/adr/`. ADR-0001, ADR-0002, ADR-0012, ADR-0016 and ADR-0017 bind this slice.
  3. This plan. ADR-0014 is Proposed; this plan makes the choices it leaves open.
  4. `docs/galaxie-project-brief.md`.
  5. `docs/system-design.md`.

  When this plan and an Accepted ADR disagree, follow the ADR and record the conflict in the PR body.
- **Execution profile:** autonomous, one branch named `feat/m1-capability-broker`, one pull request against `main`. Run units U1 to U8 in order, and `pnpm check` after each one.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a requirement can pass only by weakening an ADR-0012 guarantee, recording an argument, result, URL, header or error message in a span, or letting a binding run without a grant;
  - `~standard.jsonSchema` is missing from Zod 4.6.7 classic schemas in the Chromium Vitest project;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges, never pushes to `main`, and never enables auto-merge.

---

## Product Contract

### Summary

The runtime gains a capability broker. A host binds capabilities when it creates an instance. A graph node calls them through `host.capabilities.call(name, input, config)`. The broker denies anything not bound and granted, validates input and output, and enforces data labels, argument shapes and budgets. It records one span per call. A new `httpCapability` helper turns a host-literal URL template into a binding. Every request it sends carries agent and run attribution headers. Two new conformance cases check that a capability call and the step limit behave the same through galaxie as natively.

### Problem Frame

Slice 1 (PR #5) runs a graph but gives it no way to reach the app's data. Brief §16.3 requires the broker, data labels, argument shapes, budgets and capability spans before M1 can exit. M1 must also cover the runtime guarantees of brief §9.7: A2 (deny by default, validation both ways), A3 (no generic `fetch`, SQL or shell), A4 (no credential or argument in traces), A7 (finite budgets) and A8 (attribution header). Without the broker an agent author would call `fetch` directly. That bypasses every SDK-controlled guarantee (ADR-0002, brief §9.9).

### Requirements

**Binding and grants**

- R1. A capability call runs host code only when four things hold:
  - the agent definition requests the capability name;
  - the host passed a binding for it to `runtime.create(definition, { bindings })`;
  - its grant is in effect (R3);
  - it passes R4 to R8, R18, R19, R21 and R22.

  Any other name rejects with `denied` before host code runs. (A2)
- R2. `runtime.create` rejects with `invalid`, before any run, when:
  - a required capability has no binding;
  - a binding names a capability the definition does not request;
  - a binding field is invalid: `timeoutMs` is not a finite number above 0, `concurrency` is not a positive integer, or `kind`, `destination`, `grantScope`, `approval` or `retry` is not one of its declared values.
- R3. Bindings with grant scope `app`, `principal` or `instance` are granted for the instance's lifetime. A `run`-scoped binding runs only in a run whose `start(input, { grants })` names it. `grants` naming a capability that is not bound, or not `run`-scoped, rejects `start` with `invalid`.
- R4. The broker validates call input against the definition's request input schema before dispatch. It validates the binding's result against the request output schema after dispatch. Either failure rejects with `invalid`. An invalid input never reaches host code. An invalid output is never returned to the graph and never labels the run.
- R5. The binding decides `kind`, `destination`, timeout, concurrency, grant scope, approval and retry. The request's `kind` is never used for policy. A binding with `approval: 'confirm'` rejects every call with `unsupported` until host confirmations exist (A5, out of scope). It never runs unconfirmed.
- R6. Each call gets a signal that aborts on run cancellation, run failure, the call's timeout or the caller's signal:
  - a timeout rejects with `timeout`;
  - a run that is cancelled or failed, or an aborted caller signal, rejects with `cancelled`;
  - a binding result that arrives after the call rejected is dropped: it is not validated, not labelled and not returned. Diagnostics get a `late_result` event that carries no result value.
- R7. At most `binding.concurrency` calls of one binding run at once per instance:
  - further calls wait in FIFO order, and the wait counts against the call's timeout;
  - a slot frees only when the binding's own promise settles, not when the call times out.
- R8. The broker never retries a call. Each call gets a fresh `effectId` in its `CapabilityContext`.

**Broker-made requests and attribution**

- R9. `httpCapability(options)` returns a binding whose request the broker builds:
  - a URL template with a host-literal origin;
  - `{name}` placeholders in path segments and query values, filled with the validated input value percent-encoded;
  - for `POST`, `PUT` and `PATCH`, every input field not used by a placeholder goes in a JSON body;
  - credentials come from a host `headers(context)` callback and `credentials` mode, default `same-origin`;
  - `redirect: 'error'`.
- R10. `httpCapability` and `runtime.create` reject a template with `invalid` when any of these holds:
  - it is not absolute `https:`; `http:` is allowed only for `localhost`, `127.0.0.1` and `[::1]`;
  - a placeholder sits in the scheme, userinfo, host, port or fragment;
  - a placeholder names no top-level property of the input schema;
  - a path placeholder is filled by a `freeText` field;
  - the binding's destination is `in-browser`, or it is `user-device` and the template origin is not loopback.

  At call time the request rejects with `denied` when:
  - a path placeholder value is empty, `.` or `..` (compared case-insensitively after percent-decoding);
  - the filled URL's origin differs from the template's;
  - its path segment count differs, or a literal template segment differs from the filled segment at the same index.
- R11. Every request built by `httpCapability` carries two headers that the host callback cannot override:
  - `X-Galaxie-Agent: <agent id>@<agent version>`;
  - `X-Galaxie-Run: <run id>`.

  Core exports `attributionHeaders(context: CapabilityContext): Readonly<Record<string, string>>`, which `httpCapability` uses and custom `invoke` bindings can call to forward the same headers. Docs and comments state that these headers attribute and never authorize. Docs also state that a cross-origin target must list both headers in `Access-Control-Allow-Headers`; without that the CORS preflight fails and the call rejects `unavailable`. (A8)
- R12. `httpCapability` responses:
  - read the body with a byte cap equal to the payload budget (R22);
  - a 204 or 205 response with an empty body yields `null`, which is then validated against the output schema;
  - otherwise, a content type other than `application/json` (with any parameters) rejects with `invalid`;
  - status 401 or 403 rejects with `denied`;
  - any other 4xx rejects with `invalid`;
  - 5xx, network failure and a blocked redirect reject with `unavailable`.

  Response bodies, headers and URLs never enter errors, events, snapshots or spans.
- R13. Core offers no capability, helper, executor port or host method that lets agent code or a model choose a URL, origin, SQL text or shell command. R9 is the only network path the broker makes. Tests show that values such as `https://evil.example`, `../admin`, `a/b`, `?x=1` and `#f` stay percent-encoded inside the template's origin and path, and that `.`, `..` and `''` in a path placeholder reject `denied`. (A3)

**Data labels and argument shapes (ADR-0014)**

- R14. A schema field declares its annotation with Zod metadata: `.meta({ 'x-galaxie': { label?, shape? } })`. Core reads annotations only from the Standard JSON Schema the schema exposes, in both directions: `schema['~standard'].jsonSchema.input(...)` and `.output(...)` with `{ target: 'draft-2020-12', libraryOptions: { unrepresentable: 'any' } }` (KTD3, KTD4 say how the two combine). A run input or capability schema without `~standard.jsonSchema` makes `runtime.create` reject with `unsupported`, and so does a schema using a JSON Schema keyword the walker does not handle (KTD4).
- R15. Argument shapes come from schema constraints, and a declaration can never widen them:
  - `enum` or `const` gives `enum`;
  - `format: 'uuid'`, or a narrow `pattern` with `maxLength` ≤ 128, gives `id`;
  - a narrow `pattern` with `maxLength` ≤ 256 gives `pattern`;
  - every other string position, including unrepresentable ones and object property names without a narrow `propertyNames` pattern, is `freeText`.

  A pattern is narrow only when both hold:
  - its source has no unescaped `.`, no `\s`, `\S`, `\W` or `\D`, no negated class `[^` and no literal space;
  - `new RegExp(pattern, 'u')` matches none of the fixed probes `'a b'`, `'A B'`, `'0 1'`, `'a\nb'` and `'a\tb'`.

  A declared `shape` stricter than the constraints support makes `runtime.create` reject with `invalid`. Numbers, booleans and null are structured values, not strings.
- R16. Labels are run-level and sticky:
  - at start, the run gains every label its input schema declares, plus `app` when any value position is unlabelled;
  - each validated capability output adds the labels its output schema declares, plus `app` for unlabelled positions;
  - labels are never removed during the run;
  - `getSnapshot().run.labels` lists them, sorted.
- R17. `createRuntime({ dataPolicy })` maps each label to the destination classes it may reach:
  - the default is `public` → all five classes; `app` → `in-browser`, `user-device`, `user-endpoint` and `host-server`; `private-user` → `in-browser`;
  - a partial policy replaces only the labels it names;
  - an unknown label or destination class makes `createRuntime` throw `invalid`.
- R18. A call whose validated input holds a non-empty `freeText` string or property name rejects with `denied` before dispatch unless every label the run carries allows the binding's destination class.
- R19. The verbatim-match guard:
  - registers every string at a `private-user` position in the run input and in validated capability outputs whose normalized form (KTD6) has 8 or more characters; a `private-user` position holding an object or array registers every string inside it;
  - before a call to a destination that `private-user` may not reach, normalizes each string value and property name of the validated input separately;
  - it rejects with `denied` when a registered value occurs in one of those strings, or when one of those strings of 8 or more normalized characters occurs in a registered value.

  Registered values stay in memory for the run only. Galaxie never writes them into errors, events, snapshots, diagnostic fields it generates, or spans. The `error` field of a `capability_failed` diagnostic is the binding's own raw error: host-only evidence that may hold binding-supplied content (KTD10).

**Budgets (brief §9.4, A7)**

- R20. `createRuntime({ budgets })` takes a partial `BudgetLimits` over finite defaults:

  | Limit | Default |
  | --- | --- |
  | `steps` | 25 |
  | `toolCalls` | 50 |
  | `wallClockMs` | 300000 |
  | `payloadBytes` | 1048576 |
  | `tokens` | 100000 |
  | `cost` | 0 |
  | `repairAttempts` | 2 |
  | `uiElements` | 50 |

  `createRuntime` throws `invalid` when a value is not finite, is negative, is not an integer for a count, or when `steps` is below 1 (LangGraph rejects a `recursionLimit` below 1). This slice enforces `steps`, `toolCalls`, `wallClockMs` and `payloadBytes`. The other limits are validated and exposed, and enforced by later slices.
- R21. A call reserves one `toolCalls` unit after the grant, validation, label and guard checks pass and before host code runs. A call that would exceed the limit rejects with `budget_exceeded`.
- R22. The UTF-8 JSON size of each call's input is checked before dispatch, and its output after. For `httpCapability` the response body is read with the cap. Either one exceeding `payloadBytes` rejects with `budget_exceeded`.
- R23. The wall-clock budget runs from the moment the run enters `running`. When it expires, the run fails.
- R24. The LangGraph adapter passes `recursionLimit` to the engine: the lower of `steps` and the compiled graph's own `config.recursionLimit` when that is a positive integer, so the budget only ever lowers a graph's limit. LangGraph's `GraphRecursionError` becomes an `error` event with code `budget_exceeded` and type `GraphRecursionError`.
- R25. Any `budget_exceeded` fails the run:
  - status `failed` with error code `budget_exceeded`;
  - the run's controller aborts and core keeps draining the executor, as on cancellation;
  - the root span records `galaxie.error.code` = `budget_exceeded` and `galaxie.budget.name` = the limit's key;
  - a call-level budget also rejects that call.

**Capability spans (AT-36 subset, A4)**

- R26. Every capability call records one span `execute_tool <capability name>`, kind `INTERNAL`, whether it succeeds or not:
  - the capability name appears in the span name and `gen_ai.tool.name` only when the definition requests that name; any other call records a span named `execute_tool` with no `gen_ai.tool.name`, so caller text never reaches a span;
  - it is a child of the calling node's span when the caller gives a trace parent, and of the run's root span otherwise;
  - attributes: `gen_ai.operation.name` = `execute_tool`, `gen_ai.tool.name`, `galaxie.capability.kind`, `galaxie.destination.class` and `galaxie.step.status`; kind and destination are set only once a binding is found;
  - on failure also `error.type` and `galaxie.error.code`;
  - status `ERROR` on failure and `UNSET` on cancellation.
- R27. The fields galaxie writes never contain a call's arguments, results, URL, headers, registered `private-user` values or a binding's error message. Those fields are:
  - span names, attributes and status;
  - `error` events and `ErrorInfo`;
  - the graph-facing `GalaxieError`;
  - the snapshot fields core writes (`run.error`, `run.labels`);
  - the diagnostic fields galaxie generates.

  `stream` and `output` events and `view` carry graph state by design and stay host-local, as in slice 1. A credential canary returned by the `headers` callback, and a private canary in input and output, are absent from all of those fields.
- R28. The root span records `galaxie.run.labels` (a string array) when the run finishes.

**LangGraph adapter**

- R29. `LangGraphHost.capabilities.call(name, input, config?)` forwards to the current run's broker port:
  - the parent span comes from `config.callbacks.getParentRunId()` through the run's trace handler;
  - `config.signal` is passed as the caller's signal;
  - a call outside an active run rejects with `invalid`;
  - graph code that catches a rejection sees a `GalaxieError` with a code and a fixed message only, with no `cause`.
- R30. When a `GalaxieError` with a known code propagates out of the graph, the adapter keeps that code in its `error` event instead of reporting `executor_error`.

**Conformance and documentation**

- R31. Two new conformance cases run on all three lanes (native Node, galaxie Node, galaxie Chromium):
  - `capability`: a node calls one capability with its `config`, and the native lane calls the same deterministic implementation directly;
  - `step-limit`: a cyclic graph exceeds 25 steps.

  Each difference is fixed or recorded in the compatibility matrix with its reason.
- R32. A conformance test in the shared (non-`.node`) set runs on Node and Chromium. It shows that a graph calls a bound capability and is denied an unbound one, and that an `httpCapability` request made through an injected `fetch` carries both attribution headers.
- R33. Documentation reflects this slice:
  - `docs/system-design.md` §6 resolves "Open for M1" for `FieldAnnotation` and updates §8.3 and §9;
  - `AGENTS.md` and `README.md` state the broker, labels and budgets as implemented and the router as missing;
  - the brief's status line is updated.

### Acceptance Examples

- AE1. Covers R1, R26:
  - the definition requests `lessons.get@1` and `progress.save@1`, and the host binds only `lessons.get@1`;
  - `call('progress.save@1', …)` rejects `denied`;
  - an `execute_tool progress.save@1` span records `galaxie.error.code` = `denied`;
  - the host's code is never called.
- AE2. Covers R15, R16, R18, R19:
  - the run input has two fields labelled `private-user`: `note` = "My secret sentence about cats" and `handle` = "Cat-Lover-2049";
  - a call to a `host-server` binding with a `freeText` query rejects `denied`;
  - the same call to an `in-browser` binding succeeds;
  - a call to the `host-server` binding whose `id`-shaped field (`^[a-z0-9-]+$`, max 64) holds "cat-lover-2049" rejects `denied` via the guard. The narrow pattern admits the value, so the guard, not the shape check, catches it.
- AE3. Covers R21, R25:
  - `budgets: { toolCalls: 2 }`;
  - the third call rejects `budget_exceeded`;
  - the run fails with code `budget_exceeded`;
  - the root span has `galaxie.budget.name` = `toolCalls`.
- AE4. Covers R9 to R11:
  - template `https://api.example.test/lessons/{lessonId}`, input `{ lessonId: '../admin?x=1' }`;
  - the request URL is `https://api.example.test/lessons/..%2Fadmin%3Fx%3D1`;
  - it carries `X-Galaxie-Agent` and `X-Galaxie-Run` even though the host `headers` callback returned its own `X-Galaxie-Agent`.
- AE5. Covers R6:
  - a binding that ignores its signal resolves 50 ms after a 10 ms timeout;
  - the call rejects `timeout`;
  - the late result is dropped, the run gains no label from it, and diagnostics get `late_result`.

### Scope Boundaries

- Deferred to slice 3: the model router, mock providers, destination classes for model calls, label enforcement on model calls, consent, and `tokens`/`cost` enforcement.
- Deferred to M2 to M4: host confirmations and approvals (A5), the effect journal and `outcome_unknown` reconciliation, logout and invalidation (A10), the MCP client (A9), UI events as a label source, opted-in span text, and the injection corpus.
- Not in galaxie at all: a generic `fetch`, SQL or shell capability; model-chosen URLs; retries inferred from the HTTP method.
- Interrupts, resume and the remaining conformance cases stay in the separate conformance follow-up.

### Key Decisions

- **Bindings at `create` are the grant for instance-lifetime scopes; `run` scope needs a per-run grant.** A separate grant API adds no protection until approvals exist. Governs R1, R3.
- **`approval: 'confirm'` bindings refuse every call until confirmations exist.** Running them unconfirmed would break A5. Governs R5.
- **Default data policy keeps `app` data off `third-party`.** ADR-0014 fixes only `private-user`; `app` data read under the user's permissions should not reach a third party without the host saying so. Governs R17.
- **`cost` defaults to 0.** No remote provider exists yet, and remote spending should be opt-in. Governs R20.
- **Any exhausted budget fails the run.** A typed rejection that graph code can catch and retry in a loop would not stop runaway work. Governs R25.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The broker is per instance, in `packages/core/src/capability-broker.ts`, and executors reach it only through `RunRequest.capabilities`.** `createAgentInstance` builds the broker from the definition, the bindings and the runtime policy. Each run gets a port: `call(name, input, options?: { signal?: AbortSignal; parent?: TraceHandle }) => Promise<unknown>`. The port is bound to that run's record: labels, budget counters, controller and instrumentation. The contract stays framework-neutral (ADR-0017). Alternative rejected: a global broker on the runtime, which would mix grants and concurrency across instances and principals.
- KTD2. **Bindings travel in `CreateOptions.bindings`, typed by `BindingsFor<Definition>`.** The field is required when the definition has required capabilities and optional otherwise, through a conditional type. R2 repeats the check at runtime. `start(input, options?: { grants?: readonly CapabilityName[] })` carries run grants.
- KTD3. **Annotations live in Zod metadata and are read through Standard JSON Schema.** Zod 4.6.7 classic schemas expose `~standard.jsonSchema`, and `.meta({...})` keys appear in its output. Probed on 2026-10-28: `z.string().meta({ galaxie: … })` yields `{"type":"string","galaxie":{…}}`. Core reads the structure without importing `zod` at runtime, so `scripts/check-dependencies.ts` stays unchanged. Pass `libraryOptions: { unrepresentable: 'any' }`: unrepresentable parts become `{}`, which R15 treats as `freeText` and R16 as unlabelled. Read both directions: probed on 2026-10-28, `.transform()` keeps `x-galaxie` only in the input direction (output gives `{}`), and a label on a `.pipe()` target appears only in the output direction. Reading one direction alone silently drops labels. Export `galaxieField(annotation: FieldAnnotation): { readonly 'x-galaxie': FieldAnnotation }` from core so hosts write `.meta(galaxieField({ label: 'private-user' }))`. Alternatives rejected:
  - a host-side annotation map, which duplicates the schema and drifts from it;
  - a Zod registry, which needs a runtime `zod` import in core;
  - accepting `zod/mini` schemas without `~standard.jsonSchema` and labelling them conservatively, which would make every such run `private-user`. R14 rejects them with a clear `unsupported` instead.
- KTD4. **Annotation walking is one module, `packages/core/src/annotations.ts`, run once per schema and direction at `create` and cached.** It resolves:
  - `properties`, `additionalProperties`, `propertyNames`, `items` and `prefixItems`;
  - `anyOf`, `oneOf` and `allOf` (a position is labelled with the union of its branches' labels);
  - local `$ref` `#` (Zod emits it for recursive schemas) and `#/$defs/<name>`; cycles terminate with a visited set.

  Any other subschema keyword (for example `patternProperties`, `if`, `then`, `else`, `dependentSchemas`, `contains`, `unevaluatedProperties`, `unevaluatedItems`, `$dynamicRef`, a non-local `$ref`, or `not` other than `not: {}`) makes `runtime.create` reject with `unsupported`. Annotation-only keywords (`description`, `default`, `examples`, `format`, length and range limits) are fine. Labels are inherited by descendants, and property names inherit their object's label. Its outputs:
  - the label set of a schema, the union over both directions (for R16);
  - a matcher that walks a validated value by property path and returns the strings at `private-user` positions, where a position is `private-user` when either direction labels it (for R19);
  - a matcher that walks a validated value against the output-direction schema and returns the strings and property names at `freeText` positions (for R18).
- KTD5. **Labels are value-insensitive.** A schema that declares a label anywhere adds that label, even when the optional field is absent from the value. This is conservative and needs no taint tracking (ADR-0014 "Alternatives").
- KTD6. **The guard normalizes with `toLowerCase()`, collapses each run of Unicode whitespace to one space and trims; the minimum length is 8 characters after normalization.** These are fixed constants in `capability-broker.ts`, not configuration. The annotation matcher returns every private string, and the broker applies normalization and the length check. Values shorter than 8 characters are not registered, because short strings match too often to be useful (documented residual risk with the structured-argument channel). The guard compares string values one by one, never serialized JSON, so escaping cannot hide a match. The filled URL needs no separate scan, because its placeholder values are input strings that were already checked.
- KTD7. **`httpCapability` lives in `packages/core/src/http-capability.ts` and returns an ordinary `CapabilityBinding` plus a private marker the broker recognizes for create-time template checks (R10) and to pass the payload cap (R22) into the request.**
  - It calls `options.fetch ?? globalThis.fetch` only inside `invoke`; creating the runtime never touches the network.
  - It sets headers in this order: host `headers(context)` first, then `content-type` for bodies, then `attributionHeaders(context)` last, so R11 holds.
  - It reads the body through `response.body.getReader()` and counts bytes. It falls back to `arrayBuffer()` with a length check when `body` is null.
  - It uses `redirect: 'error'`.
- KTD8. **Budgets are enforced by a per-run `RunBudget` in `packages/core/src/budgets.ts`, created when the run enters `running`.**
  - `toolCalls` and `payloadBytes` are reserved by the broker.
  - The wall-clock timer is `setTimeout` and is cleared when the run settles.
  - `steps` is enforced by passing `recursionLimit` to LangGraph (R24), so LangGraph's own engine counts supersteps and galaxie adds no second scheduler (ADR-0001). The limit reaches the executor as `RunRequest.limits.steps`.
  - Exhaustion goes through one `failRunForBudget(run, name)` path in `agent-instance.ts`. It appends the `error` event, aborts the controller and records the budget name on the run's instrumentation.
  - In `acceptEvent`, an executor `error` event with code `budget_exceeded` goes through `failRunForBudget(run, 'steps')` instead of `failRun`. The step limit is the only budget an executor enforces.
- KTD9. **Capability spans extend `tracing.ts`.** `RunInstrumentation` gains:
  - `startCapability(meta, parent?: TraceHandle): CapabilitySpan`, where `end(result)` mirrors `TraceHandle`;
  - `setLabels(labels)`;
  - `recordBudget(name)`.

  New allowlisted keys: `gen_ai.tool.name`, `galaxie.capability.kind`, `galaxie.destination.class`, `galaxie.run.labels` and `galaxie.budget.name`. `galaxie.error.code` and `error.type` already exist; capability spans now set them too, and node and model spans are unchanged. Unended capability spans close at `finish` like node spans.
- KTD10. **Error mapping for calls:**
  - a binding that throws a `GalaxieError` with a known code keeps the code;
  - an abort caused by the call's timeout gives `timeout`, and one caused by the run or the caller's signal gives `cancelled`;
  - anything else gives `unavailable`.

  The graph always receives `new GalaxieError(code, fixedMessage)` with no `cause`. Diagnostics get the raw error as `capability_failed` with the run ID. The `DiagnosticEvent.error` doc comment states that this field may hold binding-supplied content, including private values, and that hosts must not forward it to a destination `private-user` may not reach.
- KTD11. **Conformance cases take a fourth factory parameter, `tools: { call(name, input, config): Promise<unknown> }`.** The native lane passes a direct implementation, and galaxie passes `host.capabilities.call`. `ConformanceCase` gains optional `capabilities` with the request schemas and deterministic implementations. `runGalaxie` builds the definition and the bindings from them, so all three lanes use the same graph code.

### High-Level Technical Design

```mermaid
sequenceDiagram
    autonumber
    participant N as Graph node
    participant H as LangGraph host
    participant B as Broker (per instance)
    participant R as Run record
    participant X as Host binding
    participant T as Tracing
    N->>H: capabilities.call(name, input, config)
    H->>B: port.call(name, input, {signal, parent})
    B->>T: startCapability(name, parent)
    B->>B: requested and bound? granted? approval none?
    B->>B: validate input; payload size
    B->>R: labels allow freeText? guard scan
    B->>R: reserve toolCalls
    B->>B: wait for concurrency slot (timeout running)
    B->>X: invoke(input, context with signal, effectId, agent, runId)
    X-->>B: result (late results dropped)
    B->>B: payload size; validate output
    B->>R: add output labels; register private-user values
    B->>T: end span (status, code)
    B-->>N: validated result or GalaxieError(code)
```

A `budget_exceeded` from steps 5, 7 or 11, from the wall clock, or from the executor's step limit also fails the run through `failRunForBudget`.

### Implementation Constraints

- Every new `.ts` file starts with the SPDX header from ADR-0015:

  ```ts
  // SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
  // SPDX-License-Identifier: AGPL-3.0-only
  ```

- TypeScript rules from system design §10 and `tsconfig.base.json` stay on:
  - relative imports end in `.js`, and type-only imports use `import type`;
  - exported functions declare return types;
  - no `enum`, namespaces or parameter properties;
  - `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` stay on.

  Code must compile with `tsc` (7.0.2) and `tsc6` (6.0.2).
- `packages/core/src` still imports only `@opentelemetry/api` at runtime and `zod/v4/core` as types. `scripts/check-dependencies.ts` must pass unchanged.
- Everything committed is English. Never add secrets, `.env` files or real tokens. Canaries are obviously fake strings such as `canary-credential-7f3a`.
- Never weaken a check: Biome rules, tsconfig flags, the release-age gate, the license check or an existing test assertion. Never skip a test or leave `.only`.
- Stage files by name. Never `git add -A` or `git add .`. Never commit anything under `internal/`, `spikes/`, `.beads/` or `.codegraph/`.
- Never describe galaxie as secure, compliant, certified or production-ready.
- No new dependency is needed. If one seems necessary, stop and record why in the PR body rather than adding it.

### Known Library Behavior to Respect

- Zod 4.6.7 classic: `~standard.jsonSchema.input/output({ target: 'draft-2020-12' })` exists. `z.custom()` and `z.date()` throw without `libraryOptions: { unrepresentable: 'any' }`. `zod/mini` schemas have no `~standard.jsonSchema`.
- `@langchain/core` 1.2.20: inside a node, `config.callbacks` is a `CallbackManager` with a public `getParentRunId()` that returns the node's run ID. Guard the call: `callbacks` may be an array or undefined.
- `@langchain/langgraph` 1.5.1 `/web` exports `GraphRecursionError`. The native default `recursionLimit` is 25, which is why the `steps` default is 25 and the `step-limit` case should match natively. A `recursionLimit` passed to `transform()` overrides one the graph set with `.withConfig()`, which is why R24 takes the lower of the two. A value below 1 throws a plain `Error`.
- Zod 4.6.7 emits a string-keyed `z.record` as `propertyNames` plus `additionalProperties`, and a recursive schema as `$ref: '#'`.
- `AbortSignal.any` and `AbortSignal.timeout` exist on Node 24 and Chromium. Prefer an explicit `setTimeout` plus `AbortController`, so the broker knows whether the timeout or the run caused an abort (KTD10).

### Sequencing

U1 (contracts) → U2 (annotations) → U3 (broker, budgets and the tracing extension) → U4 (`httpCapability`) → U5 (span tests) → U6 (adapter) → U7 (conformance) → U8 (docs). U3 builds the KTD9 tracing methods because its tests assert spans. U4 depends on U3; U5 depends on U3 and U4; U6 depends on U3.

---

## Implementation Units

### U1. Core contracts

- **Goal:** add the public types and defaults the broker needs, with no behavior.
- **Requirements:** R2, R3, R11, R14, R16, R17, R20 (types, defaults and `attributionHeaders`).
- **Files:**
  - `packages/core/src/policy.ts`: `DEFAULT_DATA_POLICY`, `DEFAULT_BUDGETS`, `galaxieField`.
  - `packages/core/src/capabilities.ts`: `attributionHeaders(context)`, the `CapabilityPort` interface and `HttpCapabilityOptions`.
  - `packages/core/src/executor.ts`: `RunRequest.capabilities: CapabilityPort` and `RunRequest.limits: { readonly steps: number }`.
  - `packages/core/src/instance.ts`: `RunSnapshot.labels: readonly DataLabel[]`, and `StartOptions` with `grants` on `start`.
  - `packages/core/src/runtime.ts`: `RuntimeOptions.dataPolicy` and `budgets`, and `CreateOptions.bindings` per KTD2.
  - `packages/core/src/index.ts`: exports.
- **Approach:**
  - `AgentRef.hash` is `''` until the M4 build script generates integrity metadata.
  - Add the `DiagnosticEvent` kinds `late_result` and `capability_failed`, and the `DiagnosticEvent.error` doc comment from KTD10.
- **Tests:** extend `packages/core/test/definition.test.ts` with type tests: a definition with a required capability and no `bindings` fails to compile (`// @ts-expect-error`); optional ones compile without `bindings`.
- **Verification:** `pnpm check`.

### U2. Schema annotations

- **Goal:** read labels, shapes, free-text positions and `private-user` strings from schemas (KTD3 to KTD5).
- **Requirements:** R14, R15, R16 (label sets), R19 (value extraction).
- **Files:** `packages/core/src/annotations.ts`, `packages/core/test/annotations.test.ts`.
- **Test scenarios:**
  - a nested object, array and `$defs` schema yields the expected label set;
  - an unlabelled leaf adds `app`;
  - `enum`, `const`, uuid, a narrow short pattern, a narrow long pattern and a plain string map to the R15 shapes;
  - `^[a-z0-9-]+$` with max 64 gives `id`, while `^[\w\s]+$` with max 200, `^.*$` with max 100 and `^[a-z ]{1,100}$` give `freeText`;
  - a declared `id` on a plain string is rejected;
  - a union with one `private-user` branch labels the position `private-user`;
  - a `private-user` field with `.transform()` and one whose `.pipe()` target is labelled both add `private-user`, and their values are extracted;
  - `z.custom()` and `z.date()` positions become `freeText` and unlabelled;
  - a string-keyed `z.record` makes its keys `freeText` positions that inherit the record's label;
  - a schema with `patternProperties` or a non-local `$ref` is reported as unsupported, and so is a `zod/mini` schema;
  - private-value extraction returns every string under `private-user` positions, including strings nested in a labelled object or array;
  - a recursive schema (`$ref: '#'`) terminates, and a `private-user` string in a nested child is extracted.

### U3. Broker, grants, labels and budgets

- **Goal:** enforce R1 to R8, R16 to R23 and R25 for every call through `RunRequest.capabilities`, and add the KTD9 tracing methods the broker calls.
- **Requirements:** R1 to R8, R16 to R23, R25, R26 (span recording), R27 (errors, events and snapshots).
- **Files:**
  - `packages/core/src/capability-broker.ts`, `packages/core/src/budgets.ts`;
  - edits to `packages/core/src/tracing.ts` (KTD9: `startCapability`, `setLabels`, `recordBudget`, the new allowlisted keys);
  - edits to `packages/core/src/agent-instance.ts` (run labels, budget, port, `failRunForBudget`, the `budget_exceeded` branch in `acceptEvent`) and `packages/core/src/runtime.ts` (option validation, create-time checks);
  - tests: `packages/core/test/broker.test.ts`, `packages/core/test/labels.test.ts`, `packages/core/test/budgets.test.ts`, with the `packages/core/test/fake-executor.ts` script extended to call `request.capabilities`.
- **Approach:**
  - Run checks in the order of the High-Level Technical Design.
  - Late results and calls after the run is terminal never mutate the run record.
  - The wall-clock timer starts where `run.status = 'running'` is published and is cleared in `execute`'s `finally`.
- **Test scenarios:**
  - **Binding:** AE1; an unrequested name; bound but missing from the definition at create; the R2 field validation cases; a `run`-scoped binding without and with `grants`; `grants` naming an unbound or non-run binding; `approval: 'confirm'` gives `unsupported` and host code is never called.
  - **Validation:** invalid input never reaches host code; invalid output is never returned and adds no label.
  - **Timeouts:** AE5; run cancellation during a call gives `cancelled`; a caller signal abort gives `cancelled`.
  - **Concurrency:** with `concurrency: 1`, a second call waits until the first settles; a call waiting past its timeout rejects `timeout`; a timed-out call keeps its slot until the binding settles.
  - **Labels:** AE2; labels are sticky across calls; `run.labels` is sorted; a partial `dataPolicy` replaces only named labels; unknown policy keys throw.
  - **Guard:** case and whitespace variants match; a registered value with a newline and a double quote still matches; a 20-character fragment of a registered value in an `id` field matches; a property name holding a registered value matches; values under 8 normalized characters are not registered; an `in-browser` destination is not scanned.
  - **Budgets:** AE3; an executor `error` event with code `budget_exceeded` records budget name `steps`; payload input over the limit is rejected before host code; output over the limit is rejected after; the wall clock expires with a hanging executor (use fake timers or a 20 ms budget); invalid `budgets`, including `steps: 0`, throw at `createRuntime`; defaults equal the R20 table.
  - **Secrecy:** a binding that throws `new Error('canary-binding-message')` yields `unavailable` with a fixed message; the canary is absent from the snapshot, events and the graph-facing error, and present only in the diagnostics `capability_failed` event.

### U4. `httpCapability`

- **Goal:** the broker-made request path with attribution (KTD7).
- **Requirements:** R9 to R13, R22 (body cap), R27 (credential canary).
- **Files:** `packages/core/src/http-capability.ts`, `packages/core/test/http-capability.test.ts`, export from `packages/core/src/index.ts`.
- **Test scenarios:**
  - AE4;
  - each R10 create-time rejection, including `in-browser` and non-loopback `user-device` destinations;
  - the `http:` localhost exception;
  - placeholder injection values from R13 stay encoded and keep the origin; `.`, `..` and `''` in a path placeholder reject `denied`;
  - a `PUT` answered by 204 with no body resolves `null` when the output schema accepts it;
  - a custom `invoke` binding gets the same headers from `attributionHeaders(context)`;
  - a GET with query placeholders;
  - a POST with a JSON body holding the non-placeholder fields;
  - the host `headers` callback receives the context and its credential reaches the request;
  - the credential canary never appears in errors, events, snapshots or spans;
  - the status mapping of R12, including a redirect;
  - a non-JSON content type;
  - a body over the cap is cancelled and rejects `budget_exceeded`;
  - an injected `fetch` that records requests (no network);
  - creating the binding and the runtime calls `fetch` zero times.

### U5. Capability spans

- **Goal:** prove R26 to R28 on the span tree. U3 already added the tracing methods; this unit adds `galaxie.run.labels` recording at finish (R28) and the span tests.
- **Requirements:** R25 (span attributes), R26, R27, R28.
- **Files:** `packages/core/src/tracing.ts` (R28 only), `packages/core/test/tracing.test.ts` (extend), `packages/core/test/span-tree.ts` (extend helpers if needed).
- **Test scenarios:**
  - the span tree run → node → `execute_tool lessons.get@1` with the parent handle;
  - root parent without a handle;
  - a call to an unrequested name containing a canary records a span named `execute_tool` with no `gen_ai.tool.name`, and the canary is in no span;
  - each failure code sets `error.type`, `galaxie.error.code` and status `ERROR`;
  - a cancelled call leaves status `UNSET`;
  - `galaxie.run.labels` on the root;
  - `galaxie.budget.name` on budget failure;
  - an attribute-key allowlist assertion over every span;
  - canaries from U3 and U4 are absent from all span names, attributes and status messages;
  - a capability span still open at run finish is ended.

### U6. LangGraph adapter

- **Goal:** expose the port to graphs and enforce the step limit natively.
- **Requirements:** R24, R29, R30.
- **Files:**
  - edits: `packages/adapter-langgraph/src/host.ts` (`capabilities` on `LangGraphHost`), `packages/adapter-langgraph/src/adapter.ts` (active run port, `recursionLimit`, error mapping), `packages/adapter-langgraph/src/trace-handler.ts` (`handleFor(runId): TraceHandle | undefined`);
  - tests: `packages/adapter-langgraph/test/capabilities.test.ts`, plus extensions to `packages/adapter-langgraph/test/trace-handler.test.ts`;
  - expected assertion edit: `tests/conformance/adapter.node.test.ts` "preserves the native recursion error type" now expects code `budget_exceeded` with type `GraphRecursionError`.
- **Approach:**
  - `createHost` gets a `capabilities` object whose `call` reads a mutable "active run" slot that the adapter's `run()` sets before transforming and clears in `finally`. Core's settlement barrier already prevents two active runs on one instance.
  - Error mapping: `GraphRecursionError` gives `budget_exceeded`; an `isGalaxieError` cause with a known code keeps that code; everything else is unchanged.
- **Test scenarios:**
  - a node calling with `config` produces a capability span under the node span;
  - a call without `config` parents to the root;
  - a call after the run ended rejects `invalid`;
  - a denied call caught in the node lets the graph continue;
  - an uncaught `denied` fails the run with code `denied`;
  - a cyclic graph fails with `budget_exceeded`, type `GraphRecursionError`, at `steps: 3`, and the root span has `galaxie.budget.name` = `steps`;
  - a graph compiled with `.withConfig({ recursionLimit: 3 })` still stops at 3 steps under default budgets;
  - a canary in the run input and in a capability result, run through a real graph, is absent from spans, `error` events, the snapshot's `run.error` and `run.labels`, and the graph-facing error;
  - the graph-facing error has no `cause`.

### U7. Conformance

- **Goal:** parity for capability calls and the step limit, plus cross-runtime broker checks (KTD11).
- **Requirements:** R31, R32.
- **Files:**
  - `tests/conformance/cases/capability.ts`, `tests/conformance/cases/step-limit.ts`;
  - edits: `tests/conformance/cases/index.ts`, `tests/conformance/support/transcript.ts` (the factory type gains the optional fourth parameter; the existing factories stay untouched), `tests/conformance/compatibility-matrix.json`;
  - expected assertion edits: `tests/conformance/galaxie.test.ts` and `tests/conformance/native.node.test.ts` gain the new goldens and expect `{ status: 'failed', errorType: 'GraphRecursionError' }` for `step-limit`;
  - new goldens: `tests/conformance/golden/capability.json`, `tests/conformance/golden/step-limit.json`;
  - new shared test: `tests/conformance/capabilities.test.ts`.
- **Approach:**
  - Generate goldens with `pnpm conformance:update` and inspect them for raw UUIDs and timestamps.
  - `step-limit` expects outcome `failed` with `errorType` `GraphRecursionError` in all lanes.
  - `capabilities.test.ts` uses `httpCapability` with an injected recording `fetch`, so it runs unchanged in Chromium.
- **Test scenarios:**
  - both new cases on native Node, galaxie Node and galaxie Chromium, with the matrix equal to the actual difference set;
  - a bound call succeeds and an unbound one is denied in both runtimes;
  - attribution headers are present in Chromium;
  - the existing no-network tests still pass, with the new cases included.

### U8. Docs and status

- **Goal:** R33.
- **Files:** `docs/system-design.md`, `AGENTS.md`, `README.md`, `docs/galaxie-project-brief.md` (status line only), and this plan, committed unchanged.
- **Approach:** document the CORS requirement from R11 and the host-only nature of `capability_failed.error` (KTD10) where `httpCapability` and diagnostics are described. In system design §6, add `annotations.ts`, `capability-broker.ts`, `budgets.ts` and `http-capability.ts` to the module table. Replace the "Open for M1" bullet with the KTD3 choice. Add a short "implemented in M1 slice 2" note under §8.3 that names what is still missing: journal, confirmations and retries. Do not change ADR files or their status.
- **Verification:** `pnpm check`. Wording never claims galaxie is secure or production-ready.

---

## Verification Contract

| Gate | Command | When |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | At start; no dependency changes are expected |
| Full check | `pnpm check` | After every unit and before the pull request |
| Both test projects without writing goldens | `CI=true pnpm test` | After U6, U7 and before the pull request |
| Goldens | `pnpm conformance:update` | Only in U7, for the two new cases; review the diff |
| One project | `pnpm exec vitest run --project node` or `--project 'browser (chromium)'` | While debugging |
| Browser binary | `pnpm exec playwright install --only-shell chromium` | If Chromium is missing locally |
| Format | `pnpm format` | Before each commit |

The pull request body lists:

- what each unit delivered;
- the compatibility matrix for the new cases, with reasons;
- every Known Library Behavior item the tests contradicted;
- every departure from this plan and why;
- the commands run and their results.

---

## Definition of Done

- R1 to R32 hold, each covered by at least one test named in U1 to U7. R33 is met by U8.
- AE1 to AE5 each have a test whose name cites the AE ID.
- `pnpm check` and `CI=true pnpm test` pass locally. If CI finishes before the agent stops, it is green; otherwise the PR body says CI was still running.
- `scripts/check-dependencies.ts` passes unchanged. Every existing test passes with its assertions unchanged, except the edits U6 and U7 name, which the PR body lists.
- The fields R27 names never contain a call argument, result, URL, header value, registered private value or binding error message. The canary tests prove it.
- Every new file has the SPDX header.
- The diff contains no abandoned experiment, no skipped or `.only` test, no commented-out code and no `console.log` outside test support, and no file under `internal/` or `spikes/`.
- The pull request against `main` is open, titled `feat(core): ...` per Conventional Commits, with the body from the Verification Contract, and not merged.
