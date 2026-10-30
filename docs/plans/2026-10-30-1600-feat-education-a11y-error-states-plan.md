---
title: Keyboard, Focus and Error States in Education Components - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Keyboard, Focus and Error States in Education Components - Plan

## Goal Capsule

- **Objective:** meet the brief's testing requirement (§17, "Testing and evidence"): "the quiz and writing prompt work by keyboard, with sensible focus, labels and clear error states".
  - `AgentSurface` sets `status` to `{ rejected: ErrorCode }` when a dispatch is rejected (`packages/react/src/surface.tsx`).
  - `education.Quiz/v1` and `education.WritingPrompt/v1` ignore that status, so a rejected submit shows nothing.
  - No test covers keyboard use or focus.

  This is closeout 3, slice 4.
- **Means:** component changes in `packages/react`, Chromium component tests, and docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs. Do not edit any ADR.
  3. This plan.
  4. Brief §11 and §17.
  5. `packages/react/README.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout3/education-a11y`, which holds one commit with this plan. Open one pull request against `main`. Run U1 and U2 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - An existing test assertion must change. A DOM snapshot that must change because an always-present alert container is added counts as a change; list each in the PR body.
  - A component schema, action payload or registry contract would change.
  - A golden, the compatibility matrix or an ADR would change.
  - A dependency or `pnpm-lock.yaml` would change. Use the test tooling that is already installed. Do not add axe or a testing-library package.
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Error state.** When `status` is `{ rejected: code }`, Quiz and WritingPrompt render one fixed English message from a trusted map in the component module, keyed by `ErrorCode`, inside an element with `role="alert"`.
  - Suggested messages:
    - `invalid`: "Check your answer and try again."
    - `duplicate`: "This answer was already sent."
    - `stale`: "This question is no longer active."
    - all other codes: "Your answer could not be sent. Try again."
  - The message never contains model text, props or the draft.
  - Link the form's submit button or the form to the alert with `aria-describedby` while the error is shown.
  - The inputs stay enabled after a rejection, so the learner can retry, and the draft or selection is kept.
  - Any later status clears the message: `submitting`, `accepted` or `idle`.
  - Reuse one small shared piece, such as a helper or a component in `components/`, for both components only if that is natural.
- R2. **Focus.** On a transition into the rejected state, move focus to the first invalid control if one can be identified, and otherwise to the alert or the submit button. Pick one rule, document it, and test it. Do not move focus on the first render.
- R3. **Keyboard and labels.** Verify, and fix if needed:
  - every radio group has a `fieldset` and `legend`;
  - the textarea has a label;
  - the submit buttons have accessible names;
  - Quiz can be answered and submitted using only Tab, the arrow keys, Space and Enter;
  - WritingPrompt can be filled and submitted using Tab, typing and Enter on the button.
  - Disabled states while submitting do not trap focus.
- R4. **Tests**, in the Chromium React project, extending `packages/react/test/components.test.tsx` or a new file:
  - keyboard-only completion of both components, with real key events through the existing browser test tooling;
  - an alert with a fixed message for each code group;
  - focus moving after a rejection;
  - inputs re-enabled and the draft kept;
  - the message cleared on resubmit;
  - accessible names.
- R5. **Docs.** Update:
  - the `packages/react` README section on components: error states, the focus rule, and that messages are fixed English that hosts may wrap;
  - the `docs/mvp-exit-record.md` entry that tracks this brief requirement, if one exists, citing the tests;
  - the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No i18n system.
- No styling.
- No Feedback or Progress changes, beyond verifying their headings and labels.
- No host change.

## Implementation Units

- **U1. Components and tests.** R1–R4.
- **U2. Docs.** R5.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 and U2 are complete.
- Rejected submits show a fixed alert, and focus moves as documented.
- Keyboard-only use is tested.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/react/src/components/{quiz.tsx,writing-prompt.tsx,feedback.tsx,progress.tsx}`.
- `packages/react/src/surface.tsx` and `registry.ts` (`InteractionStatus`).
- `packages/react/test/components.test.tsx` and `surface.test.tsx`.
- `vitest.config.ts`, for the Chromium project.
