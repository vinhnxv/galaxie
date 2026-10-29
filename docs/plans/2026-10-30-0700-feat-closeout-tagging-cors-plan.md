---
title: MVP Closeout - Backend Tagging and CORS Evidence - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# MVP Closeout - Backend Tagging and CORS Evidence - Plan

## Goal Capsule

- **Objective:** close two partial acceptance tests that the MVP exit record lists:
  - **AT-29:** every broker request carries the agent header, and a backend fixture rejects tagged requests to a sensitive endpoint.
  - **AT-16:** an existing API binding works, and CORS and auth failures are reported, not hidden.

  The work is test evidence through the real runtime and `httpCapability` against a loopback HTTP fixture. Product code changes only if a test exposes a real defect, in which case the stop conditions apply. This is closeout slice 3 of 4.
- **Means:**
  - a loopback HTTP fixture started from the conformance global setup;
  - one conformance test file running on Node and Chromium;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief §9.7 A8, AT-16 and AT-29.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline: tests reach only loopback servers. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout/tagging-cors`, which holds one commit with this plan. Open one pull request against `main`. Run U1 to U3 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a file under `packages/` or `examples/` would need a non-test change. If a test shows that `httpCapability` hides a CORS or auth failure, record it with `test.fails` and a comment, and stop.
  - an existing test assertion must change;
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Fixture (`tests/conformance/support/http-fixture.node.ts`)**

- R1. A `node:http` server bound to `127.0.0.1` on an ephemeral port. It uses no new dependency and has the routes below.
  - `GET /public/items/:id` returns 200 JSON. It records the request's `X-Galaxie-Agent` and `X-Galaxie-Run` headers.
  - `POST /sensitive/account` returns 403 with a fixed JSON body whenever the request carries `X-Galaxie-Agent`. It records that it rejected the request. Without the header it would return 200, but no SDK test sends a request without the header.
  - `GET /auth/required` returns 401 unless `Authorization: Bearer fixture-token` is present.
  - CORS behavior is controlled by the origin of the instance:
    - **CORS-enabled instance:** answers preflights and sets `Access-Control-Allow-Origin` to the exact runner origin. `Access-Control-Allow-Headers` lists `content-type`, `authorization`, `x-galaxie-agent` and `x-galaxie-run`.
    - **No-CORS instance, on a separate port:** sends no CORS headers at all.

  Start two instances, CORS and no-CORS, in the existing conformance global setup, beside the MCP fixtures. Provide them as `inject('http')`, carrying `{ corsUrl, noCorsUrl, adminUrl }` or the equivalent. Read back what each instance recorded through a small admin route or the existing command pattern (`mcp-commands.node.ts`), and reset between tests. Node tests may create a fixture locally, as `mcp.test.ts` does. The browser runner origin is `http://127.0.0.1:63315`, the fixed `api` host and port in `vitest.config.ts`. Use it as the exact `Access-Control-Allow-Origin` value.
  - `httpCapability` accepts absolute `http:` URLs only on loopback (`isHttpDestination` in `urls.ts`), and rejects the `in-browser` destination.
  - Declare the bindings with destination `host-server`, following the existing usage in `tests/conformance/capabilities.test.ts`.
  - Loopback to loopback stays in the same address space, so Local Network Access raises no prompt.
  - The custom `X-Galaxie-*` headers make every cross-origin call send a preflight, so the no-CORS server always receives an `OPTIONS` request first.

**Tests (`tests/conformance/http-integration.test.ts`, Node and Chromium)**

- R2. **AT-29.** Through a real runtime instance with `httpCapability` bindings for `items.get@1` and `account.update@1`:
  - The read succeeds. The fixture recorded `X-Galaxie-Agent` equal to `<agent id>@<version>` and `X-Galaxie-Run` equal to the run ID.
  - The sensitive write is tagged, and the fixture rejects it with 403. The capability fails `denied`, the run reports a fixed error, and the response body text appears in no event, diagnostic, span or error.
  - A host `headers` callback that tries to remove or override the attribution headers does not succeed. This mirrors the existing unit test, now against a real server.
- R3. **AT-16, auth.** A 401 from `/auth/required` without a token fails `denied`. Adding the token through the binding's host `headers` callback succeeds.
- R4. **AT-16, CORS.** These run in Chromium only, guarded on `typeof window !== 'undefined'`, because Node has no CORS.
  - The CORS-enabled fixture works cross-origin, including the custom-header preflight.
  - A call to the no-CORS fixture, with `credentials: 'omit'` or the default, fails with the fixed `unavailable` error. The failure is reported, meaning the capability rejects and the run's error is fixed. It is never a silent success or a `null` result.
  - The no-CORS server still records that the request reached it, as a preflight or a simple request. This shows the failure happened at the browser's CORS check, not because the server was unreachable. Assert this only if it is deterministic; otherwise document it.

**Docs**

- R5. Update:
  - the AT-16 and AT-29 rows in `docs/mvp-exit-record.md`, citing the new tests and setting the status honestly. Keep the notes that attribution is not authorization and that a CORS failure maps to `unavailable` without distinguishing CORS from other network failures, if that is the behavior;
  - `tests/conformance/README.md`;
  - the AGENTS.md status paragraph.

### Scope Boundaries

- No change to how errors are mapped. In particular, add no CORS-specific error code. Recording the current mapping is in scope.
- No real third-party endpoint.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Loopback fixtures in the existing global setup.** The MCP fixtures already prove that this pattern works on both projects. The CORS check needs a real cross-origin server in a real browser.

## Implementation Units

- **U1. Fixture and global setup.** R1.
- **U2. Tests.** R2–R4.
- **U3. Docs.** R5.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| No product change | `git diff --stat main -- packages examples` is empty. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U3 are complete.
- AT-29's sensitive-endpoint rejection and AT-16's auth and CORS failures are tested through the runtime.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `packages/core/src/http-capability.ts` (status mapping: 401 and 403 become `denied`, other 4xx become `invalid`, a fetch failure becomes `unavailable`) and `capabilities.ts` (`attributionHeaders`).
- `tests/conformance/support/mcp-global.node.ts`, `mcp-context.ts` and `mcp-commands.node.ts`.
- `vitest.config.ts`, `packages/core/test/http-capability.test.ts` and `docs/mvp-exit-record.md`.
