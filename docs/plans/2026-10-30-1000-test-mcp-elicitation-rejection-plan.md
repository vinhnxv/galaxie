---
title: MCP Elicitation Rejection Evidence - Plan
type: test
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# MCP Elicitation Rejection Evidence - Plan

## Goal Capsule

- **Objective:** close the remaining AT-33 gap. AT-33 requires that the client "rejects sampling and elicitation requests".
  - Sampling rejection is already tested. `examples/mcp-server` sends an unadvertised `sampling/createMessage` request during a tool call, records the client's JSON-RPC error code, and the conformance tests assert that error.
  - Elicitation has no such probe. The exit record says elicitation "is not separately injected".
- **Means:**
  - an `elicitation/create` probe in the reference server, built like the sampling probe;
  - a conformance assertion on Node and Chromium;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0012. Do not edit any ADR.
  3. This plan.
  4. Brief AT-33.
- **Execution profile:** autonomous, in Node and headless Chromium. Work offline: tests reach only loopback servers. The only network use is `git push` and `gh` at the end. Work on the existing branch `closeout2/mcp-sampling-elicitation`, which holds one commit with this plan. Open one pull request against `main`. Run U1 and U2 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - `packages/tools-mcp` would need a change. In particular, if the client accepts or answers the elicitation request with anything other than a JSON-RPC error, record that with `test.fails`, add a comment that names the gap, and stop.
  - an existing test assertion must change;
  - a golden, the compatibility matrix or an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

- R1. **Probe.** `examples/mcp-server/src/index.ts` adds `requestElicitation()` and `elicitationCode()`, parallel to `requestSampling()` and `samplingCode()`.
  - On the next tool call, the server sends `{ jsonrpc: '2.0', id: 'elicitation-probe', method: 'elicitation/create', params: { message: 'Probe.', requestedSchema: { type: 'object', properties: {} } } }`. It uses `transport.send` with the related request ID, exactly as the sampling probe does.
  - It records the client's error code from the response.
  - The probe changes no existing server behavior.
  - Wire the new controls through every existing control path the sampling probe uses: the context, commands and global fixtures under `tests/conformance/support`, and any example tests.
- R2. **Assertion.** Next to each existing sampling-rejection assertion, add an elicitation case on Node and Chromium.
  - The client answers with a JSON-RPC error. Assert the same code family the sampling test asserts, for example `-32601` method not found, or whatever the SDK returns for an undeclared capability.
  - The tool call itself still completes, or fails, exactly as it does in the sampling case.
  - No elicitation text or prompt reaches the agent, a run event or a span.
  - Assert that the client's `initialize` request advertises neither `sampling` nor `elicitation`, if the existing tests do not already.
- R3. **Docs.**
  - Update the AT-33 row in `docs/mvp-exit-record.md`, citing the new test, and set its status honestly.
  - Update the `tests/conformance/README.md` MCP section and the `packages/tools-mcp` README or `AGENTS.md` where they describe sampling rejection.
  - Update the AGENTS.md status paragraph in one clause.

### Scope Boundaries

- No elicitation support.
- No change to the client.

## Implementation Units

- **U1. Probe and assertions.** R1 and R2.
- **U2. Docs.** R3.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| No client change | `git diff --stat main -- packages` lists only Markdown files. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 and U2 are complete.
- Elicitation rejection is tested on Node and Chromium.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- `examples/mcp-server/src/index.ts` (the sampling probe).
- `packages/tools-mcp/src/session.ts`, where the client declares `capabilities: {}`.
- `tests/conformance/mcp.test.ts` and `support/mcp-*.ts`.
- `docs/mvp-exit-record.md` row AT-33.
