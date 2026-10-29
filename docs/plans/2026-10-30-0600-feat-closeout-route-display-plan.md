---
title: MVP Closeout - Hosts Show the Selected Model Destination - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# MVP Closeout - Hosts Show the Selected Model Destination - Plan

## Goal Capsule

- **Objective:** close the AT-22 gap the MVP exit record lists. AT-22 requires that the first-run order is followed, that no class switches silently, and that **the UI shows the destination**. Core already publishes `snapshot.routes[role]` with `providerId`, `destination` and `changedFrom` (ADR-0006). host-local renders none of it, so the M2 real run had to infer its destination. host-remote shows only raw destinations in an ad-hoc header.

  This slice adds a small headless component to `@galaxie/react` and renders it in both example hosts. It is closeout slice 2 of 4.
- **Means:**
  - a `ModelRoutes` component in `@galaxie/react`;
  - wiring in `examples/host-local` and `examples/host-remote`;
  - tests;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0006 and ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief §10, AT-22 and §5.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium.
  - Work offline except for `git push` and `gh` at the end.
  - Work on the existing branch `closeout/route-display`, which holds one commit with this plan.
  - Open one pull request against `main`.
  - Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change. The one exception is the exact `header` `allTextContents()` assertion in `examples/host-remote/test/loop.node.test.ts`, which the new `ModelRoutes` assertions replace.
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. `@galaxie/react` exports `ModelRoutes`.
  - Props:
    - `instance`;
    - optional `labels?: { readonly roles?: Readonly<Record<string, string>>; readonly providers?: Readonly<Record<string, string>> }`, with trusted host text for role and provider names;
    - optional `destinationLabels`, overriding the default English text for each destination class.
  - It reads `useAgentSnapshot(instance).routes` and renders one list item per role, in the order the snapshot gives: `<role label>: <provider label> (<destination label>)`.
  - When `changedFrom` is present, the item adds a visible notice: `changed from <previous destination label>`.
  - The `aria-live="polite"` container is always rendered, so that the first selection is announced. When there are no routes, only the named list (`Model destinations`) is left out.
  - Keep `role="status"` off the container, because host tests locate the run status with `getByRole('status')`.
- R2. All rendered text is React text. Identifiers without a label render as their raw IDs, which are host-defined. No model output is rendered. Default destination labels are fixed English strings for the five classes. Hosts may localize them through props. Do not add i18n infrastructure.
- R3. **Wiring.**
  - Both `examples/host-local` and `examples/host-remote` render `<ModelRoutes instance={instance} />` next to the run status, with host-chosen labels.
  - host-local labels both provider sets: `builtin` and `webllm` in real mode, `quiz` and `review` in mock mode.
  - host-remote replaces its ad-hoc `<header>` route paragraphs with `<ModelRoutes>`. Its labels cover the quiz's remote route and the feedback's in-browser route.
  - The tutor graph does not change.
- R4. **Tests.**
  - `packages/react/test/model-routes.test.tsx`, on Chromium, covers:
    - rendering from a snapshot with two roles;
    - provider and role labels;
    - fallback to raw IDs;
    - the `changedFrom` notice;
    - the live region;
    - no list items when there are no routes, while the live container is still present;
    - updates when the snapshot changes;
    - Strict Mode.
  - Use the existing React test patterns and helpers, such as fake instances or a mock-provider runtime.
  - Extend the host loop tests by adding assertions, except for the host-remote header replacement above. Routes are published per instance, after each role's first routed call, so a restored instance starts empty.
    - In host-local, assert the quiz route after the quiz radios appear and before the first `page.reload()`. After the feedback step, assert only `tutor.feedback`.
    - In host-remote, assert the remote class for the quiz and `in-browser` for feedback, under the test-mode providers the loop uses.
- R5. **Docs.**
  - Update the `packages/react` README and `AGENTS.md`.
  - Update system design §8.4 and the ADR-0006 notice text where the system design describes host display.
  - Update the AT-22 row of `docs/mvp-exit-record.md`, citing the new tests. Keep the note that browser language availability is faked in CI, and state that a restored session shows a role only after its next routed call.
  - Update the AGENTS.md status paragraph.

### Scope Boundaries

- No consent dialog UI. Consent remains the host hook.
- No core change.
- No styling system.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A reusable headless component in `@galaxie/react`, with labels from the host.** Both hosts need the same display, and other hosts get it for free. Labels stay trusted host text, as with the education components.

## Implementation Units

- **U1. Component and tests.** R1, R2 and the component tests in R4.
- **U2. Host wiring and loop assertions.** R3 and the loop assertions in R4.
- **U3. Docs.** R5.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml examples/english-tutor` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- Both hosts visibly show each role's provider and destination after that role's first routed call in an instance, and announce changes.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/core/src/instance.ts` (`AgentSnapshot.routes`) and `models.ts` (`PublishedModelRoute`).
- `packages/react/src`.
- `examples/host-local/src/app.tsx` and `runtime.ts`, `examples/host-remote/src/app.tsx` and `runtime.ts`, and their loop tests.
- `docs/mvp-exit-record.md` row AT-22.
