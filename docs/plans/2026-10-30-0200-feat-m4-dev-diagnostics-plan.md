---
title: M4 Development Diagnostics - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 Development Diagnostics - Plan

## Goal Capsule

- **Objective:** add best-effort development warnings to `@galaxie/core` (brief §16.6 and §9.9). They cover:
  - missing CSP directives or Trusted Types;
  - unbound capabilities;
  - roles without an available provider;
  - provider keys found in web storage;
  - blocked model-produced URLs.

  Production builds emit no warning and run no check. This is M4 slice 8.
- **Means:**
  - one opt-in `RuntimeOptions.developmentWarnings` callback in core;
  - checks at runtime creation, instance creation and interaction rejection;
  - tests on Node and Chromium;
  - host-local wiring;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0006, ADR-0012 and ADR-0014. Do not edit any ADR.
  3. This plan.
  4. Brief §9.7–§9.9 and §16.6.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline except for `git push` and `gh` at the end. Work on the existing branch `m4/dev-diagnostics`, which holds one commit with this plan, and open one pull request against `main`. Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**API (`packages/core/src/development.ts`, exported from the root)**

- R1. `RuntimeOptions.developmentWarnings?: (warning: DevelopmentWarning) => void`.
  - When the option is absent, galaxie runs no check: no storage read, no CSP or Trusted Types probe, no extra provider probe. It emits nothing, so a production build that omits the option pays no cost.
  - Hosts enable it from their build flag, for example `import.meta.env.DEV`.
  - A throwing callback never affects a run, and `DiagnosticEvent` stays unchanged.
    - When an instance-scoped warning (capability, role or URL) throws, the instance's `report` reports it once as `listener_threw`.
    - When a runtime-level warning (CSP, Trusted Types or storage) throws, the error is swallowed and rethrown with `queueMicrotask`, the same pattern `report()` uses for throwing diagnostics.
- R2. `DevelopmentWarning` is `{ readonly code: DevelopmentWarningCode; readonly instanceId?: InstanceId; readonly name?: string; readonly area?: 'localStorage' | 'sessionStorage' }`.
  - `name` carries only a trusted identifier from the definition or host options, such as a capability name, a model role or a CSP directive name. It never carries model output, storage values, storage keys, URLs, origins or credentials.
  - Each warning is emitted at most once per runtime for each combination of code, `instanceId`, `name` and `area`.
- R3. The warning codes are:
  - `csp_unenforced`;
  - `trusted_types_unenforced`;
  - `capability_unbound`;
  - `role_without_provider`;
  - `provider_key_in_storage`;
  - `url_blocked`.

**Checks**

- R4. **CSP and Trusted Types.** These run once at `createRuntime`, only in a page context where `document` exists, and are skipped in workers and on Node. Both are best effort, because page code cannot read response headers.
  - `trusted_types_unenforced`: assigning a string to `innerHTML` on a detached `template` element does not throw. Under `require-trusted-types-for 'script'` that assignment throws a `TypeError`. Restore nothing, because the element is detached and discarded.
  - `csp_unenforced`, with `name: 'script-src'`: `new Function('return 1')` succeeds, meaning `'unsafe-eval'` is allowed or there is no script policy. The probe body is constant and returns no value to anything.
  - Under an enforced policy, each probe produces one expected blocked-eval or Trusted Types violation per runtime creation in development, logged to the console. The browser also sends a report if the page declares a reporting endpoint, and a report-only policy reports without blocking. In each of these cases the probe emits no warning. Document this in a code comment, in the R12 docs and in the host-local README.
  - A host whose Trusted Types default policy passes strings through `createHTML` gets `trusted_types_unenforced` even though Trusted Types is enforced. Document this as a known false positive.
- R5. **Capabilities.** This check runs inside instance creation, after the broker is built and the `instanceId` exists, and before the instance starts.
  - `capability_unbound` fires when an optional requested capability has no binding. It carries the capability name.
  - Creation already rejects a missing required binding and a binding for an unrequested capability with `invalid`. No warning is emitted for either.
- R6. **Roles.** These checks run inside instance creation, after the router is built.
  - Creation already rejects with `invalid` a role with no route, an empty provider list or an unknown provider ID. No warning is emitted for those.
  - `role_without_provider`, carrying the role name, fires when none of the role's providers matches the role's `requires`.
    - The descriptor-matching rule is the router's: required features, plus the primary-subtag language match.
    - Move that rule into one internal function in `model-router.ts`. The router and the check both call it. Do not duplicate it.
  - If `models.availability` exists, the check also probes each provider of each role once, with the router's request shape.
    - `create` awaits the probes. Each probe gets a signal from a controller that is aborted when the instance is disposed.
    - A provider counts as usable when the probe returns `available`, or `downloadable` while the descriptor's destination is `in-browser` and `models.download` is set.
    - The check warns when no provider of the role is usable.
    - A probe that throws, rejects or returns an invalid result counts as unavailable and reports no diagnostic.
    - The probe result never changes routing.
- R7. **Storage.** This runs once at `createRuntime`, in a page context.
  - Read `localStorage` and `sessionStorage` inside `try`, because access can throw.
  - Test each value against fixed patterns. Every match must start at the beginning of the value or after a character outside `[A-Za-z0-9_-]`:
    - `sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`;
    - `AIza[0-9A-Za-z_-]{35}`;
    - `(?:gsk_|hf_|xai-|r8_)[A-Za-z0-9]{20,}`.
  - Emit `provider_key_in_storage` with only `area` for each area that matched. Never emit the key, the value or a count.
  - Never write to or delete from storage.
- R8. **Blocked URLs.**
  - Have `interactionError` return its reason, `'url'` or `'binding'`, together with the error.
  - Emit `url_blocked` only for `'url'`, at both sites that report `interaction_rejected`: the live-run site and the restore site in prepare.
  - Set `name` to the component only when `options.ui` is defined and `Object.hasOwn(options.ui.components, component)`. Otherwise emit `url_blocked` with `instanceId` only.
  - Never include the URL, the origin or the prop path.

**Tests**

- R9. `packages/core/test/development.test.ts`, on Node, covers:
  - every capability and role case, including the availability-probe variants and a throwing probe;
  - de-duplication;
  - a throwing callback;
  - storage patterns, plus a negative test where `task-` followed by 20 characters and `half_value` do not match;
  - both storage areas matching, which emits two warnings;
  - `url_blocked` with `ui` absent, which carries no `name`;
  - the absent option: spy on storage reads and on the availability hook, and assert zero calls and zero warnings.

  For storage on Node, use injected fake `localStorage` and `sessionStorage` globals restored after each test, and a fake `document` only where needed. Use synthetic values such as `sk-` followed by repeated `x`, never a real key.
- R10. `tests/conformance/development-warnings.test.ts`, on Node and Chromium, covers:
  - `url_blocked` through a real LangGraph interrupt with a non-allowlisted URL, carrying no URL text in the warning;
  - in Chromium: `trusted_types_unenforced` and `csp_unenforced` on the default test page, where neither is enforced, and `provider_key_in_storage` after writing a synthetic key to `localStorage`, removed in `finally`;
  - in every environment: with the option absent, a full run emits nothing;
  - in Chromium with the option absent: spies on `globalThis.Function` and on the `innerHTML` setter of `HTMLTemplateElement.prototype` (or `Element.prototype`) record no access during `createRuntime` and a run. Restore both spies afterwards.

  The host-local loop test may also assert that its strict-CSP preview page emits no `csp_unenforced` or `trusted_types_unenforced`, only if host-local wires the option in that mode (R11).
- R11. **Host-local wiring.** `examples/host-local` passes `developmentWarnings` only when `import.meta.env.DEV` is true, logging `console.warn('[galaxie]', warning.code, warning.name ?? '', warning.area ?? '')`. Built preview pages, including the loop test's, therefore emit nothing.

**Docs**

- R12. Document the option, the codes, what each check can and cannot see, and that it is best effort (brief §9.9). Update:
  - system design §9 or the diagnostics section;
  - `docs/security-review.md`, adding the warnings as an aid, not a control;
  - the AGENTS.md status paragraph and the README status.

### Scope Boundaries

- No browser extension or devtools panel.
- No reading of response headers through `fetch(location.href)`, which would be a network request.
- No automatic remediation.

### Assumptions

- Chromium enforces `require-trusted-types-for` by throwing a `TypeError` on string assignment to `innerHTML`. The default Vitest browser page sends no CSP.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **One opt-in callback, separate from `diagnostics`.** `DiagnosticEvent` reports run failures, and hosts may forward it to telemetry. Development warnings are advice that must not run in production, so the absent option disables every check.
- KTD2. **Content-free warnings.** Codes and trusted identifiers only, so a warning can go to the console or a log without leaking keys, URLs or model text.

### Output Structure

```text
packages/core/src/development.ts
packages/core/test/development.test.ts
tests/conformance/development-warnings.test.ts
examples/host-local/src/runtime.ts (wiring)
```

### Implementation Constraints

- New files carry the SPDX header. The compiler rules in AGENTS.md apply.
- Checks never throw into the host. Every page probe is wrapped, and a page probe that fails emits no warning. The availability-probe failures in R6 are the exception and count as unavailable.

## Implementation Units

- **U1. API and capability/role checks.** R1–R3, R5, R6 and their R9 tests.
- **U2. Page checks.** R4, R7 and R8, plus their tests from R9 and R10.
- **U3. Host-local wiring.** R11.
- **U4. Docs.** R12.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- Every warning code has a test.
- With the option absent, no check runs and no warning is emitted.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §9.7–§9.9 and §16.6.
- `packages/core/src/runtime.ts` (`RuntimeOptions`, `DiagnosticEvent`), `agent-instance.ts` (the `interaction_rejected` sites, `output_safety_unset`), `models.ts` (`ModelRouting`, `availability`) and `model-router.ts`.
- `examples/host-local/src/runtime.ts` and `csp.ts`.
