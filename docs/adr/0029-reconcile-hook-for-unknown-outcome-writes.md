# ADR-0029: Optional reconcile hook for unknown-outcome writes

- **Status:** Proposed
- **Date:** 2026-11-08
- **Related:** brief §12.3; ADR-0009, ADR-0012, ADR-0014
- **Revisions:**
  - 2026-11-08: initial proposal; this record adds no runtime behavior.

## Context

A restored write with `retry: 'none'` and a `dispatched` or `outcome_unknown` receipt currently persists `outcome_unknown` and fails with `outcome_unknown`, without invoking the binding. The host must reconcile with its backend outside the framework. Starting a new session derives new effect IDs, so it can repeat the logical operation even if the earlier request applied. Preventing that repeat is why the restored call is blocked.

The capability broker owns the effect journal and every executor's brokered writes. It can use a host answer about the existing effect ID without introducing executor-specific recovery or another journal. The existing recovery flow is described in [system design §8.3](../system-design.md#83-a-capability-call).

## Decision

### Binding contract

Add an optional property to `CapabilityBinding<Input, Output>`:

```ts
readonly reconcile?: (effectId: string, context: CapabilityContext) => Promise<ReconcileResult>;
```

Its result is:

```ts
type ReconcileResult<Output = unknown> =
  | { outcome: 'applied'; output: Output }
  | { outcome: 'not-applied' }
  | { outcome: 'unknown' };
```

The binding property uses the untyped result because an `applied` output is host data that the broker validates against the capability's output schema before it is trusted. A host may still annotate its own function with `ReconcileResult<MyOutput>`.

The hook receives the effect ID and the usual `CapabilityContext`, including the abort signal, run ID, principal scope and agent attribution. It never receives the call input. The hook is valid only with `retry: 'none'`. A supplied non-function hook, or a hook on an `idempotent` or `idempotency-key` binding, fails creation with the constructor's existing `invalid` error.

### Restored-write flow

In the restored-write branch, when the receipt is `dispatched` or `outcome_unknown`:

1. Persist `outcome_unknown` as today.
2. If the binding has a hook, consult it once, before requesting any approval. Bound the consult by the binding's `timeoutMs` and pass a signal that aborts on timeout, cancellation or disposal.
3. Handle the answer in this order:
   - **`applied`:** apply the same payload bound and output-schema validation as for an invoke result. Record `succeeded` through the existing success path, register output labels and private values as for an invoke result, and return the validated output. Do not invoke the binding or request approval.
   - **`not-applied`:** continue through the existing retryable-replay path under the same effect ID: obtain fresh approval when required, persist `planned`, persist `dispatched`, then invoke. Preserve the policy rechecks and single-use approval consumption before invocation.
   - **`unknown`:** fail `outcome_unknown` and leave the receipt `outcome_unknown`. A thrown error, rejected promise or malformed answer also fails `outcome_unknown`.

Without a bound hook, retain the existing calls, journal writes, diagnostics and errors. New calls and other receipt states keep their existing behavior. This is a single consult per restored call, not an immediate retry or polling loop.

Add two content-free diagnostic kinds, `effect_reconciled_applied` and `effect_reconciled_not_applied`, each carrying the effect ID for its corresponding accepted outcome. Neither includes hook output or call input. Raw host errors retain the existing host-only diagnostic rules.

### Failure modes

Every failure below leaves the receipt `outcome_unknown`, so a later restore consults the hook again. No failed consult authorizes an invocation or publishes an approval request.

| Failure | Broker behavior |
| --- | --- |
| `unknown` answer | Fail `outcome_unknown`. |
| Hook throws or rejects | Fail `outcome_unknown`; also report `capability_failed` with the raw error in the host-only `error` field, subject to its existing destination limits. Public errors and generated diagnostic fields contain no host error text. |
| Malformed result | Fail `outcome_unknown`; do not accept a partial result. |
| `applied` output fails output-schema validation | Fail `invalid`; do not record `succeeded` or return the output. |
| Consult exceeds `timeoutMs` | Fail `timeout` and abort the hook's signal. Bound the consult in both approval modes. A `confirm` binding's ordinary deadline starts only after approval, so the consult needs its own timer. |
| Run cancellation or runtime disposal | Fail `cancelled` and abort the hook's signal. Discard any late answer. |

### Host obligations

- **A sound `not-applied` answer is final.** It must mean the backend will never apply that effect ID later, for example because the backend has installed a tombstone that refuses it. In [ADR-0009](0009-multi-tab-ownership.md), the **Remote effects** case states: "A request the old owner already sent may still complete." An absence check alone cannot exclude that late request. Core cannot verify whether the host's answer is sound.
- **An `applied` output matches the capability's output schema.** The broker validates and bounds it before settling the receipt or returning it.
- **The hook is idempotent and safe to call again.** A failed or interrupted consult leaves the receipt unresolved; a later restore may consult it again.
- **Labels still apply.** The hook receives no labelled input, and an `applied` output carries the capability's output labels and registers private values under [ADR-0014](0014-data-labels-and-argument-shapes.md), just as an invoke result does.
- **A new invocation needs fresh approval when required.** `not-applied` does not reuse or bypass a confirmation. Host-rendered approval remains bound to the exact parameters and effect ID, preserving [ADR-0012](0012-security-baseline.md) control A5.
- **A custom `RecoveryStore` accepts `planned` after `outcome_unknown`.** `idempotent` and `idempotency-key` replay already write this edge. The exported `EFFECT_TRANSITIONS` table does not list it, and neither the broker nor either store enforces that table. Leave the table and its lifecycle test unchanged.

## Alternatives considered

- **Fail `not-applied` with a new error code.** Leaves the call blocked, which is the gap this hook closes.
- **Let every retry policy declare the hook.** `idempotent` and `idempotency-key` already replay under the same effect ID; a hook would add a second authority over that decision.
- **Put a host callback on `RuntimeOptions`.** The binding already owns the retry policy, and the capability name scopes the lookup.
- **Add a core-owned polling loop.** Out of scope; the hook is consulted once per restored call.

## Consequences

- Hosts can resolve an unknown write and continue the restored call under its original effect ID, without starting a new session that could repeat it.
- There is no change to the stored effect record, `RECOVERY_FORMAT_VERSION` or `@galaxie-ai/storage-indexeddb`. No migration is introduced.
- Core validates the hook answer and output but cannot establish backend truth or recall a former owner's request. A false `not-applied` answer can repeat a write; the host must enforce the finality described above.
- Existing bindings without a hook retain their behavior. This proposal adds no executor-specific recovery, new error code, polling loop or general exactly-once HTTP guarantee.

## Verification

Implementation is future work. The following new tests will verify the contract by behavior; these paths are not present yet:

- `packages/core/test/reconcile.test.ts`: binding validation; consulting once before approval for both unresolved receipt states; validated and bounded `applied` output settling through the success path without invoke or approval and registering labels and private values; `not-applied` replay under the same effect ID with fresh approval; the failure modes above, including timeout in both approval modes, cancellation, disposal and repeated consultation after a later restore; content-free diagnostics; and unchanged behavior without a hook.
- `tests/conformance/reconcile.test.ts` on Node and Chromium: restored LangGraph writes through the real broker and recovery store, proving `applied` returns without another write, `not-applied` invokes once under the original effect ID, and unresolved answers remain blocked. Chromium will exercise IndexedDB reopen; Node will use memory storage.

Unmeasured: the ADK JavaScript, Python and Go and Pyodide executors with a hook; DSPy, which keeps its own Python-side replay journal; Firefox and WebKit; any real backend; and whether a host's `not-applied` answer is sound, which core cannot check. Future mock and conformance results will not establish backend finality.

For this documentation-only proposal, the host runs `pnpm run check:docs` to verify Markdown links and heading anchors. That check does not verify the ADR index; read back the new row in [the index](README.md#index) separately. No runtime tests are added by this record.
