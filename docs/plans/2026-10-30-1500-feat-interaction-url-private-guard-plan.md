---
title: Private-String Guard on Interaction URLs - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Private-String Guard on Interaction URLs - Plan

## Goal Capsule

- **Objective:** close the AT-32 gap for model-produced links. AT-32 reads: "A run carrying `private-user` data cannot send it through SDK paths to a disallowed class: not in free-text capability arguments, remote model calls, form actions or model-produced links". Brief §9 threat rows 2 and 14 call for a verbatim-match guard.
  - The capability broker already denies arguments that contain a registered private string (`packages/core/src/capability-broker.ts`, `checkPolicy`, `normalize`, `registerPrivate`).
  - Interaction URLs are checked by origin only (`checkInteractionUrls` and `isAllowedUrl` in `packages/core/src/interactions.ts`, called from `interactionError` in `packages/core/src/agent-instance.ts`). A model can therefore place the learner's private sentence in the query of an allowlisted URL, and the link becomes pending UI.
  - For form actions, the education forms have no `action`, and both example hosts send `form-action 'none'`. No test asserts that header.

  This is closeout 3, slice 2.
- **Means:** a core guard, tests on Node and Chromium, a CSP assertion, and docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief AT-32 and §9.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium, with mock models. Work offline: tests reach only loopback servers. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout3/url-private-guard`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - An existing test assertion must change. The `url-query-on-allowlisted-origin` corpus case uses a synthetic, unregistered value, so it must keep passing unchanged as a documented residual risk.
  - The injection corpus's case count or combination-coverage assertion would need to change in a way that removes coverage. Adding a case and updating a count assertion by exactly the number of added cases is allowed; record it in the PR body. If that is awkward, put the new cases in a separate test file instead.
  - A golden, the compatibility matrix or an ADR would change.
  - A dependency or `pnpm-lock.yaml` would change.
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Shared matcher.**
  - Move the broker's normalize-and-match logic into one exported internal helper in core, for example `containsPrivate(value, registered)` beside `registerPrivate`. The broker uses it with unchanged behavior: the same normalization, the `includes` rule and the 8-character reverse rule.
  - No public API change. If the helper must cross files, keep it out of the package's public exports.
- R2. **Interaction URL guard.**
  - `interactionError` receives the run's `privateValues` and the instance policy. Every URL candidate in the pending props is a string that `urlCandidate` already recognizes. For each one, compute these forms:
    - the raw string;
    - the string with `+` replaced by a space and percent-decoding applied, where a decode failure keeps the raw string;
    - the same decoding applied a second time, to catch double encoding.
  - If any form contains a registered private string, the interaction is rejected exactly like a blocked URL: reason `url`, `denied`, the `interaction_rejected` report and the existing `url_blocked` development warning. Its content-free shape is unchanged.
  - The guard does not apply when the `private-user` policy allows `third-party`, because a followed link reaches an arbitrary site. Document this choice.
  - This applies on both paths that call `interactionError`: a fresh interrupt, and a restored pending interaction.
  - Do not add a new error code, warning code or destination class.
- R3. **Tests.**
  - Core unit tests:
    - a URL whose query carries a registered sentence, in plain, percent-encoded, `+`-encoded and double-encoded forms, is rejected;
    - the same URL with an unregistered value passes;
    - the path form is rejected too;
    - a policy that allows `third-party` for `private-user` lets the URL through.
  - Conformance on Node and Chromium: add an injection case where the obedient-attacker mock emits an interaction whose allowlisted URL query carries the learner's private sentence, which was registered through the accepted payload. Assert:
    - the run fails `denied`;
    - nothing becomes pending;
    - no network request carries the sentence;
    - events, spans and errors carry neither the sentence nor the URL.

    Keep the synthetic residual case unchanged.
  - Host CSP tests in `examples/host-local` and `examples/host-remote`: add an assertion that the CSP contains `form-action 'none'`.
- R4. **Docs.** Update:
  - the `tests/injection-corpus/README.md` residual note, which now covers unregistered values only;
  - `docs/security-review.md`, where it maps AT-32 and LLM02 or LLM05;
  - the `docs/unsupported.md` or system design notes on origin-only URL checks;
  - the AT-32 row in `docs/mvp-exit-record.md`, citing the new tests. Paraphrases, structured channels and unregistered values remain residual risks, so the status may stay partial;
  - the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No paraphrase or taint tracking.
- No React registry change. The renderer still checks origins, and core now rejects the interaction before it is rendered.
- No change to the capability broker's behavior.

## Implementation Units

- **U1. Matcher and guard.** R1 and R2, with unit tests.
- **U2. Corpus case and CSP assertions.** R3.
- **U3. Docs.** R4.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- Model-produced interaction URLs carrying registered private strings are rejected.
- `form-action 'none'` is asserted in both hosts.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/core/src/capability-broker.ts` (`normalize`, `strings`, `registerPrivate`, `checkPolicy`).
- `packages/core/src/interactions.ts` (`urlCandidate`, `checkInteractionUrls`).
- `packages/core/src/agent-instance.ts` (`interactionError`, `privateValues`).
- `tests/conformance/injection-corpus.test.ts`, `tests/injection-corpus/cases.json` and its README.
- `examples/host-local/src/csp.ts` and `examples/host-remote/src/csp.ts`, with their tests.
- `docs/security-review.md` and `docs/mvp-exit-record.md`.
