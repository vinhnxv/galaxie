---
title: Percent-Decoding in the Capability Broker Private-String Guard - Plan
type: fix
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Percent-Decoding in the Capability Broker Private-String Guard - Plan

## Goal Capsule

- **Objective:** close a hardening gap that the third independent audit found. This is closeout 5.
  - The interaction URL guard matches registered private strings against three forms of each candidate: the raw string, the decoded string and the double-decoded string. Decoding includes malformed-escape run decoding (`decodeUrl` in `packages/core/src/interactions.ts`).
  - The capability broker's verbatim guard (`checkPolicy` in `packages/core/src/capability-broker.ts`) matches raw strings only. A percent-encoded copy of a registered private sentence in a structured capability argument therefore passes to a destination that `private-user` does not allow.
  - Brief §3.3 accepts structured arguments as a documented low-bandwidth channel. This change narrows that channel. It does not close it.
- **Means:** a shared decode helper, tests and docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief §3.3, §9 and AT-32.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout5/broker-decode`, which holds one commit with this plan. Open one pull request against `main`. Run U1 and U2 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - An existing test assertion must change. Any existing test whose capability arguments contain percent sequences must keep passing unchanged.
  - A golden, the compatibility matrix or an ADR would change.
  - A dependency or `pnpm-lock.yaml` would change.
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Shared decode.**
  - Move `decodeUrl` into `packages/core/src/private-values.ts` and give it a neutral name, for example `percentDecode`.
  - Add a helper there, for example `containsPrivateEncoded(value, registered)`. It returns true if the raw form, the decoded form or the double-decoded form contains a registered value, using the existing `containsPrivate` on each.
  - The interaction URL guard uses the helper, and its behavior stays the same.
  - The broker's `checkPolicy` uses the helper for every string and key, keeping today's policy condition: the check runs only when `private-user` does not allow the binding's destination.
  - Treating `+` as a space applies in both guards. This is a conservative choice, because it can only add matches.
- R2. **Tests.**
  - Core broker tests cover a capability argument carrying a registered sentence in each of these forms, each denied to a disallowed destination:
    - percent-encoded;
    - `+`-encoded;
    - double-encoded;
    - encoded next to a malformed `%ZZ`.
  - The same argument passes to a destination that the policy allows.
  - An unregistered encoded value passes.
  - Errors and diagnostics stay fixed and content-free.
  - If an injection-corpus or conformance test already sends a free-text tool-output case through the broker, add one Node and Chromium conformance case with an encoded registered sentence in a structured argument. Otherwise, core tests are enough.
- R3. **Docs.**
  - Update the `docs/security-review.md` row for the broker verbatim guard, and the matching notes in `docs/system-design.md` and `docs/unsupported.md`: encoded verbatim copies are now matched.
  - Keep the documented residual risks: paraphrases, other encodings such as base64, and unregistered values.
  - Update the AT-32 row in `docs/mvp-exit-record.md`, citing the new tests. It stays partial for those residual risks.
  - Update the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No new encodings beyond percent and `+`.
- No change to the labels policy.
- No new error code.

## Implementation Units

- **U1. Helper, broker wiring and tests.** R1 and R2.
- **U2. Docs.** R3.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 and U2 are complete.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/core/src/private-values.ts`, `interactions.ts` (`decodeUrl`, `checkInteractionUrlPolicy`) and `capability-broker.ts` (`checkPolicy`).
- `packages/core/test/interaction-private.test.ts` and the broker tests in `packages/core/test/`.
- `docs/security-review.md` and `docs/mvp-exit-record.md`.
