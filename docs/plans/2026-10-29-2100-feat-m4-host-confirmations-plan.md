---
title: M4 Host-Rendered Confirmations - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 Host-Rendered Confirmations - Plan

## Goal Capsule

- **Objective:** make capability bindings with `approval: 'confirm'` work, behind a confirmation that the host renders from the real arguments. This satisfies ADR-0012 A5, brief §9.7 A5 and AT-28:
  - Confirmation text comes from the host registry and the real parameters.
  - Agent content cannot render a look-alike that triggers the effect.
  - An approval cannot be replayed. It becomes invalid after its arguments change, after expiry, on logout and on takeover.

  This is M4 slice 3. It also enables MCP write tools from slice 2, which are already bound with `approval: 'confirm'`.
- **Means:**
  - core: a confirmation gate in the capability broker. The instance publishes pending confirmations in its snapshot and exposes `respond(id, decision)`.
  - `@galaxie/react`: a host confirmation registry and a `ConfirmationPrompt` component. It is separate from `AgentSurface` and the agent component registry.
  - Tests on Node and Chromium, including an MCP write through the reference server.
  - Docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0004, ADR-0007, ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief §9.6, §9.7 (A5 and A10) and AT-28.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous and offline, in Node and headless Chromium. Work on the existing branch `m4/confirmations` and open one pull request against `main`. Run U1 to U5 in order, with `pnpm check` after each. No dependency is added or changed.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change, other than the one named in U4;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency or the lockfile would change;
  - confirmation arguments, a confirmation ID or host text would reach an error message, span attribute, diagnostic, run event or log, apart from the existing opt-in `developmentTraceText` argument recording that R6 names;
  - a `confirm` binding could be invoked without a matching, unused, unexpired approval;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Configuration**

- R1. `CreateOptions.confirmations?: ConfirmationOptions` configures confirmations per instance. It has these fields:
  - `capabilities: readonly CapabilityName[]`: the capabilities the host can render. `runtime.create` fails `invalid` when a bound capability with `approval: 'confirm'` is missing from this list. Unknown names in the list are allowed, so one host registry can serve several agents.
  - `policyRevision: () => string`: the host's current policy revision, for example a hash of its grant and binding configuration. It must return a non-empty string of at most 128 characters; anything else fails the call with `unavailable`.
  - `expiresInMs?: number`: how long a confirmation stays open. It must be a safe integer from 1,000 to 600,000, with a default of 120,000. Outside that range, `create` fails `invalid`.
  - `signals?: readonly AbortSignal[]`: host signals that end every approval, typically the logout watcher's `signal` and `ownership.signal`. `create` fails `invalid` when an entry is not an `AbortSignal`.
- R2. Without `confirmations`, a `confirm` binding keeps failing `unsupported` at call time, exactly as today. The existing core broker test stays unchanged.

**The gate**

- R3. **Order in the broker.** For a `confirm` binding, the confirmation sits after the existing checks and before any effect:
  1. input validation, payload budget, data-label policy and the tool-call reservation, as today;
  2. the recovery journal read. A `succeeded` record replays without a confirmation. A `dispatched` or `outcome_unknown` record under `retry: 'none'` fails `outcome_unknown` without a confirmation, as today.
  3. **the confirmation** (R4–R8);
  4. journal `planned`, the concurrency slot, the `dispatched` record and `invoke`, as today.

  The binding's `timeoutMs` deadline starts only after approval. Waiting is bounded by the expiry, by run cancellation and by the run's wall-clock budget.
- R4. **What is bound.** At request time, core records the following in memory only:
  - the instance's `principalScope`;
  - the capability name;
  - the canonical arguments, as a deep-frozen copy of the validated value. The SHA-256 digest is taken over the canonical JSON that the broker already uses for recovery digests. Arguments that are not plain JSON fail `invalid`.
  - the effect ID: the journal's deterministic effect ID with recovery, or a fresh `crypto.randomUUID()` without it. The same ID is the `CapabilityContext.effectId` that the dispatch receives.
  - the `policyRevision()` value;
  - `expiresAt`, an epoch time in milliseconds;
  - a confirmation ID from `crypto.randomUUID()`, branded `ConfirmationId`. The model, the graph, run events and traces never see it.
- R5. **What `invoke` receives.** `invoke` receives exactly the frozen approved value; core never re-reads the original object. Immediately before `invoke`, core checks that this value's digest still equals the bound digest, and that `policyRevision()` still equals the bound revision. A mismatch fails `denied` without invoking.
- R6. **Snapshot.** While open, a confirmation appears in `AgentSnapshot.confirmations?: readonly PendingConfirmation[]`, in request order. The field is absent when none is open. Each entry is a frozen `{ id, capability, arguments, expiresAt }`. Opening or closing one publishes a new snapshot through `subscribe`, following the existing identity rules.
  - The snapshot is in-page host data, like `run.pending`.
  - Arguments still never reach run events, diagnostics, spans or errors. One existing exception stays: the opt-in `developmentTraceText` path records call arguments in spans before dispatch, gated by live labels and the declared trace destination. It applies to `confirm` bindings unchanged and is outside the leak stop condition. Confirmation IDs and host text never reach spans, even with that option set.
- R7. **Responding.** `AgentInstance.respond(id, decision: 'approve' | 'decline'): ConfirmationReceipt` is synchronous and single use. `ConfirmationReceipt` is `{ status: 'approved' | 'declined' | 'stale' }`.
  - The first valid response wins and closes the entry.
  - Every later response, and any response to an unknown, expired, invalidated or closed ID, returns `stale` and changes nothing.
  - A non-string ID or an unknown decision returns `stale`.
  - `respond` never throws, so a host button cannot crash the page.
- R8. **Ending a confirmation.** Each of the following closes the entry and fails the call. Each emits one fixed diagnostic without arguments or IDs, except `runId`.

  | Cause | Call fails with | Diagnostic |
  | --- | --- | --- |
  | Decline | `denied` | `confirmation_declined` |
  | Expiry, by timer, checked again at approval and at dispatch | `denied` | `confirmation_expired` |
  | Abort of any `confirmations.signals` entry (logout, takeover) | `denied` | `confirmation_invalidated` |
  | Policy revision changed at approval or at dispatch | `denied` | `confirmation_invalidated` |
  | Instance disposal | the existing run-cancellation code, `cancelled` | `confirmation_invalidated` |
  | Run cancellation or run end | the existing code, `cancelled` | none |
  | Run wall-clock budget | the waiting call settles `cancelled`, and the run fails `budget_exceeded`, as today | none |

  Disposal and run aborts already abort the broker's call controller, so the existing error mapping decides the call's code. Do not change that mapping. Disposal tests assert three things: the diagnostic, the closed snapshot entry and that `invoke` was never called.

  - A signal that is already aborted when a confirmation would open fails it immediately, without publishing it.
  - The broker also emits `confirmation_requested` when an entry opens.
  - The span for the call records the outcome through the existing fixed outcome attribute only.
- R9. **No replay.** An approval authorizes one dispatch of one call. A later call with identical arguments opens a new confirmation. With recovery, a retried call after reload opens a new confirmation, because approvals are never persisted. The journal's `succeeded` replay needs none, because it makes no new effect.
- R10. **Concurrency.** Several confirmations may be open at once, for example from parallel tool calls. Each is independent. They do not hold concurrency slots while waiting.

**React**

- R11. `defineConfirmations(entries)` from `@galaxie/react` takes `Readonly<Record<CapabilityName, ConfirmationEntry>>`. A `ConfirmationEntry` is:
  - `title: string`: a fixed host string;
  - `fields: (args: unknown) => readonly { readonly label: string; readonly value: string }[]`: a host function that derives display rows from the real arguments;
  - optional `approveLabel` and `declineLabel`, with the defaults `Allow` and `Cancel`.

  It validates entries at definition time, throwing `GalaxieError('invalid')` for a bad shape. It returns:
  - `capabilities`, the list to pass as `confirmations.capabilities`;
  - `entry(name)`.
- R12. `ConfirmationPrompt({ instance, confirmations })` renders the instance's open confirmations from `useAgentSnapshot`.
  - Title, labels and button text come only from the host entry. Values come from `fields(arguments)` and render as React text, never as HTML.
  - Approve and decline call `instance.respond`.
  - When `fields` throws or returns a bad shape, or no entry exists, the prompt shows only a fixed "This action cannot be shown." text and a decline button. It never shows an approve button.
  - The prompt lives outside `AgentSurface`, and nothing in `ComponentProps` reaches `respond` or a confirmation ID. Agent components receive only `props`, `actions` and `status`, as today.

**MCP and the reference server**

- R13. MCP write tools bound with `approval: 'confirm'` run once approved, with no change to `@galaxie/tools-mcp` beyond docs. The reference server's `progress.record` handler already authorizes from the verified principal, never from `_meta`. Its `admin.lastMeta()` already holds the received `galaxie.dev/effect`, so `examples/mcp-server` needs no change.

**Docs**

- R14. Update the following, without describing galaxie as secure:
  - `docs/system-design.md`: the §9 A5 row and the paragraphs that say "A5 bindings refuse dispatch until confirmations exist" and "approval invalidation remains M4 work";
  - the `watchInvalidation` doc comment;
  - the AGENTS.md project status paragraph;
  - the README status;
  - `packages/tools-mcp/README.md`;
  - the `packages/react` README or docs section.

  State the limits:
  - Approvals live in page memory, so a reload asks again.
  - Same-origin code can call `respond`, because the gate protects against model-controlled content, not against page scripts (brief §9.9).
  - The host must dispose the instance on logout and takeover, and should also pass those signals.
  - Backends must still authorize every write (B1).
  - An expired or declined approval does not undo a request that was already sent.

### Scope Boundaries

- No persistence of approvals or pending confirmations across reloads.
- No `examples/host-local` or `examples/english-tutor` change: `progress.save@1` stays `approval: 'none'`, because deterministic code calls it.
- No confirmation for model routing or downloads; ADR-0006 consent is separate.
- No server-side approval tokens or approval headers. Backends see only the existing attribution and effect ID.
- No ESLint rule (slice 6) and no injection corpus (slice 7).

### Assumptions

- Hosts already dispose instances on logout and ownership loss (system design §8.5 and §8.6). The `signals` option narrows the window before disposal.
- The canonical JSON used for recovery digests is deterministic for plain JSON, which validated capability arguments are in every existing binding.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **In-process gate, not a host callback.** A callback returning `true` could be cached and replayed by the host. A core-held record with a single-use ID makes R7 and R9 structural and testable. The snapshot model already serves `useSyncExternalStore`.
- KTD2. **Approval after the journal read.** Replays and unknown outcomes never ask the user about an effect that will not happen.
- KTD3. **Dispatch the frozen copy.** Re-checking the digest of the object `invoke` receives closes the gap where agent code mutates the argument object after approval.
- KTD4. **Capability coverage is checked at create.** This mirrors `ui: registry.bindings(...)`: a `confirm` binding the host cannot render fails early, instead of producing a prompt that can only be declined.
- KTD5. **Fixed outcomes.** Every non-approval fails `denied`, distinguished only by diagnostics. This keeps model-visible errors free of host detail.

### Output Structure

- `packages/core/src/confirmations.ts`: the types (`ConfirmationOptions`, `PendingConfirmation`, `ConfirmationReceipt`, `ConfirmationId`) and the gate.
- `packages/core/src/capability-broker.ts`: the gate call in the order of R3, the effect ID moved before the confirmation, and the frozen-copy dispatch.
- `packages/core/src/agent-instance.ts`, `instance.ts`, `runtime.ts`, `ids.ts` and `index.ts`: the create-time validation, the snapshot field, `respond`, disposal, the diagnostics kinds and the exports.
- `packages/react/src/confirmations.tsx`, plus exports from `index.ts`.
- Tests:
  - `packages/core/test/confirmations.test.ts`;
  - `packages/react/test/confirmations.test.tsx`;
  - `tests/conformance/confirmations.test.ts`, on both projects;
  - the MCP write test in `tests/conformance/mcp.test.ts`.
- Test support, with no assertion changes:
  - `tests/conformance/support/mcp-context.ts` adds `meta: Record<string, unknown>` to `McpAdminState`;
  - `tests/conformance/support/mcp-global.node.ts` fills it from `server.admin.lastMeta()`;
  - `packages/react/test/support/fake-instance.ts` gains a mocked `respond` and settable snapshot `confirmations`. Other fakes that implement `AgentInstance` get the same treatment.

### Implementation Constraints

- New files carry the SPDX header. The compiler rules in AGENTS.md apply.
- Keep `check:deps` passing, and update it only if a new file path needs a rule.
- Timers must be cleared on every exit path, and listeners on every exit path, including `confirmations.signals`.
- Use the existing fixed error helper and `toErrorInfo` messages.

## Implementation Units

- **U1. Core gate.** Add the types and the gate, the broker order (R3–R5, R8–R10), the create-time validation (R1, R2), and the minimum of R6 and R7 the tests below need: open entries in the snapshot and `respond`.
  - Tests in `packages/core/test/confirmations.test.ts`:
    - approve, then invoke with the frozen value and the bound effect ID;
    - decline;
    - expiry with fake timers;
    - each signal abort, including one already aborted;
    - disposal;
    - a policy revision change at approval and at dispatch;
    - an argument mutation after approval being refused;
    - a second `respond` returning `stale`;
    - an identical second call opening a new confirmation;
    - parallel confirmations;
    - a recovery `succeeded` replay with no confirmation;
    - `outcome_unknown` with no confirmation;
    - the timeout starting after approval;
    - cancellation while waiting;
    - create rejecting a missing capability and bad options;
    - no arguments or IDs in diagnostics, events or spans, using the existing tracing test helpers.
- **U2. Snapshot and `respond` details.** Complete R6 and R7, with tests for snapshot identity, publication order and `respond` never throwing on bad input.
  - A confirmation closed from a run-abort listener runs inside the instance's outer `publish`.
  - Defer the gate's publication, or merge it into that publish, so that no snapshot published after the run fails still lists the entry.
- **U3. React.** Add R11 and R12, with Chromium tests:
  - the text comes from the entry;
  - values render as text, so a `<img src=x onerror=...>` value stays text;
  - the fallback for a missing or throwing entry has no approve button;
  - an `AgentSurface` component cannot reach `respond`: an agent action named `approve` only dispatches an interaction;
  - Strict Mode.
- **U4. Conformance and MCP.**
  - `tests/conformance/confirmations.test.ts` on Node and Chromium maps every AT-28 clause to a test: registry text, look-alike, replay, argument change, expiry, logout through a real `watchInvalidation` announce, and takeover through an ownership signal.
  - Replace the slice 2 test "write confirmations remain unsupported and never reach the server" in `tests/conformance/mcp.test.ts` with two tests:
    - an approved `progress.record` reaches the server once. A wrapper around the binding's `invoke` captures `context.effectId`. The test asserts that it equals `state.meta['galaxie.dev/effect']` and that `calls` rose by exactly one.
    - a declined one never reaches it.

    This is the only existing assertion that may change.
- **U5. Docs.** Add R14.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Behavior kept | Every pre-existing test passes with unchanged assertions, except the one named in U4. | every unit |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |
| No leaks | Tests assert that diagnostics, run events, spans and error messages carry no argument value, confirmation ID or host text. | U1, U4 |

## Definition of Done

- U1 to U5 are complete.
- A `confirm` binding runs only after a single-use approval of its exact frozen arguments, effect ID and policy revision, before expiry and before any invalidation.
- The host renders the text from its own registry.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §9.6 (threats 1, 4 and 15), §9.7 A5 and A10, §9.9 and AT-28.
- ADR-0012.
- `packages/core/src/capability-broker.ts`: the `approval === 'confirm'` refusal, the journal order and the effect ID derivation.
- `packages/core/src/invalidation.ts` and `ownership.ts`: the signals.
- `packages/react/src/registry.ts` and `surface.tsx`.
- `tests/conformance/mcp.test.ts` and `examples/mcp-server`.
