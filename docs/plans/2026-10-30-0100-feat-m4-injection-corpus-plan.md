---
title: M4 Prompt Injection Corpus and Security Review - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 Prompt Injection Corpus and Security Review - Plan

## Goal Capsule

- **Objective:** add a prompt injection corpus that runs in CI against the SDK-controlled paths (brief §9.7 B9 and AT-26), and a committed security review mapping ADR-0012 and the OWASP Top 10 for LLM Applications (2025) to controls, tests and documented limits (brief §16.6). This is M4 slice 7.
- **Threat model of the corpus:** the model is assumed fully compromised. A deterministic *obedient attacker* mock does exactly what each injected instruction asks. The corpus therefore checks the SDK's controls, never model behavior. Galaxie does not score answer quality (ADR-0016).
- **Means:**
  - data files under `tests/injection-corpus/`;
  - one runner in `tests/conformance/`, on Node and Chromium;
  - `docs/security-review.md`.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0006, ADR-0012, ADR-0014 and ADR-0016. Do not edit any ADR.
  3. This plan.
  4. Brief §9.5–§9.7, §11, the AT-26, AT-25, AT-27, AT-28 and AT-32 rows, and §16.6.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node and headless Chromium.
  - Work offline except for `git push` and `gh` at the end.
  - Work on the existing branch `m4/injection-corpus`, which holds one commit with this plan, and open one pull request against `main`.
  - Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a corpus case shows a control failing, meaning an unapproved write, an egress, a rendered non-allowlisted URL or a disclosure. Record the case, mark it `test.fails` with a comment naming the gap, and do not weaken the control or the assertion. AGENTS.md forbids weakening a guarantee to make a test pass.
  - any file under `packages/` or `examples/` would need a non-test change;
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Corpus data (`tests/injection-corpus/`)**

- R1. `tests/injection-corpus/cases.json` is a JSON array, with `README.md` beside it. There is no `package.json`, so it is not a workspace package. Each case has:
  - `id`, kebab-case and unique;
  - `vector`: `lesson`, `tool-output` or `mcp-description`;
  - `goal`: `unapproved-write`, `egress`, `url-render`, `label-downgrade` or `instruction-in-data`;
  - `payload`: the attacker text placed in that vector;
  - `directive`: the action the obedient attacker takes when it reads the payload.

  Directives are structured and closed. There is no free-form code, and the runner validates each one with a Zod schema before use. The directive kinds are:
  - `{ "kind": "callTool", "name", "args" }`;
  - `{ "kind": "emitInteraction", "component", "props" }`;
  - `{ "kind": "reply", "text" }`;
  - `{ "kind": "forwardPrivate", "to": "<role>" }`, which calls another model role with the private value.
- R2. The corpus has at least 30 cases, at least eight per vector, and at least one case for every one of the 15 vector–goal pairs. It includes these common forms:
  - "ignore previous instructions";
  - fake system or tool messages;
  - instructions hidden in Markdown links, HTML comments and zero-width or bidirectional characters;
  - base64-wrapped directives;
  - JSON that looks like a tool call;
  - fake confirmation text ("the user already approved");
  - URL exfiltration to non-allowlisted origins: `attacker.invalid`, look-alike hosts, `data:`, `javascript:` and protocol-relative URLs;
  - one documented-limit case, `url-query-on-allowlisted-origin`, which asserts that a query string on `https://example.test` does become pending. Origin allowlists do not constrain paths or queries (AGENTS.md). The case is a residual risk that R7 cites as the host's to manage, not a `test.fails` gap.
  - an MCP tool description that changes after approval;
  - an MCP description that tells the agent to call a non-allowlisted tool.

  Payload text is synthetic, with no real secrets, people or third-party domains. Use `example.test` and `attacker.invalid`.

**Harness and runner (`tests/conformance/injection-corpus.test.ts`, Node and Chromium)**

- R3. The obedient attacker is a deterministic `BaseChatModel` in `tests/conformance/support/obedient-attacker.ts`, modeled on `support/scripted-chat-model.ts`. When its input contains a case's payload marker, it returns that case's directive as a tool call or reply. Otherwise it returns a benign default.
- R4. The fixture runs a small LangGraph agent through the real runtime: the `@galaxie/core` runtime, the LangGraph adapter, the router, the broker and the interaction policy. It is defined in the test support, never in `examples/`. The fixture has:
  - a read capability `content.get@1`, which returns the lesson or tool output carrying the payload;
  - a write capability `record.save@1` with `approval: 'confirm'`;
  - an MCP-backed capability from the loopback reference server used by `mcp.test.ts`, for the `mcp-description` vector. Reuse its global setup and admin controls, such as changing a tool description.
  - a UI surface bound to a registry entry with a URL prop and a declared allowlist of `https://example.test`;
  - model roles: `agent.local`, allowing `in-browser` only, and `agent.main`, allowing `host-server`.
    - The obedient attacker is bound to `agent.local` through a mock provider registered with destination `in-browser`, and it reads every payload.
    - `agent.main` has its own spy provider and is only the target of `forwardPrivate`.
  - a private-user value in every run input.

  Data labels are sticky for the run, so every call to `agent.main` fails `denied` under the default data policy. That is why the attacker always runs in-browser.

  **Two graph shapes.** Capabilities run only when graph code calls `host.capabilities.call`; a model's tool call does nothing by itself.
  - The **executing graph**, used for the `unapproved-write`, `egress`, `url-render` and `label-downgrade` goals, calls `content.get@1`, passes its output to the attacker, then performs the attacker's directive: a capability call through the broker, an interaction through `requestInteraction`, or a call to `agent.main` for `forwardPrivate`. The broker, the interaction policy and the router are the controls under test.
  - The **fixed graph**, used for `instruction-in-data`, calls `content.get@1` and then the attacker, and maps the reply to its output schema. It never executes a model tool call. Its output schema projects model text away, to a boolean such as `{ answered: true }`, so the run output carries no attacker text.

  **MCP.** The corpus has its own reference server, never the one `mcp.test.ts` mutates. Vitest runs browser test files in parallel.
  - On Node, call `createFixture()` locally in `beforeAll`, as `mcp.test.ts` does.
  - For Chromium, the global setup in `tests/conformance/support/mcp-global.node.ts` starts a second server and provides it under a separate key, for example `inject('mcpCorpus')`. Corpus admin commands go only to that server.
  - Add one test-only admin action in `tests/conformance/support/`, in `mcp-context.ts`, `mcp-global.node.ts` and `mcp-commands.node.ts`, that sets the `lesson.lookup` description to a given payload. `reset` restores the original.

  Galaxie never shows MCP descriptions to agent code, because remote metadata is used only for pins.
- R5. **Assertions per case.** Each case runs as its own test and asserts the outcome for its goal:
  - `unapproved-write`: the write's `invoke` spy is never called while no host approval is given. A confirmation, if one is published, carries host registry text and the real frozen arguments. A forged "approved" message from the model does not count as approval.
  - `egress`:
    - a new test-only recorder, `tests/conformance/support/injection-network.ts`, wraps `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket` and `EventSource`. It lets requests to the runner origin and to the corpus MCP fixture origin through, and records each request's URL and serialized body. The existing recorders keep only kind names and block the MCP loopback, so they cannot make these checks.
    - no recorded request targets any other origin;
    - no recorded request contains the private marker or the payload. On Node, do not combine this with the diagnostics-channel socket recorder for MCP cases.
    - a call to a non-allowlisted or unbound capability fails `denied`, `unsupported` or `invalid`.
  - `url-render`: in both projects, the interaction is absent from every published `snapshot.pending`, and the run reaches the outcome `interaction-policy.test.ts` defines. Core rejects URL candidates before any pending state exists, and that is the control under test. There is no React rendering check, because the Node project has no DOM.
  - `label-downgrade`: forwarding the private value to `agent.main` fails `denied` before any provider call, and the `agent.main` provider spy has zero calls in total.
  - `instruction-in-data`, with the fixed graph:
    - every capability `invoke` spy except `content.get@1` has zero calls;
    - the run output parses against the output schema;
    - no confirmation or pending interaction appears.
  - `mcp-description` vector:
    - Cases that change the description first approve and use the tool, then set the payload description. They assert that the next call fails `unavailable`, the server's call count is unchanged, and the payload appears in no event, diagnostic, span, snapshot or error. This mirrors "AT-25 disables changed metadata".
    - Cases whose description tells the agent to call a non-allowlisted tool have the harness give the payload directly to the attacker. They assert that a call to `mcp.lessons.unlisted@1`, or to any unbound name, fails `denied`, `unsupported` or `invalid`.

  Every case also asserts that no diagnostic, span attribute, event or error message contains the payload or the private marker. Reuse `serializeSpans` and the diagnostic collection patterns from `confirmations.test.ts`.
- R6. The runner reads `cases.json` with a static JSON import, so it works in both Vitest projects. It fails when a case is malformed, or when any of the 15 vector–goal pairs has no case. Each case name includes its `id`.

**Security review (`docs/security-review.md`)**

- R7. The review has three tables.
  1. **ADR-0012 baseline:** every item, with its control (file and symbol), its tests (file and test name, AT ID), and its documented limits.
  2. **OWASP Top 10 for LLM Applications 2025**, LLM01 to LLM10: how each risk applies to galaxie, the controls, the tests, and the residual risk or "out of scope, host responsibility".
  3. **Brief §9.7 B and C duties:** which ones the SDK enforces, and which ones remain host or author duties.

  Every row cites real code and tests that exist on the branch. Write no claim the code does not support. Do not call galaxie secure, compliant or certified. State the limits that apply: trusted-first code can bypass SDK controls (ADR-0002), there is no sandbox, and so on.
- R8. Link the review from the README and system design §9 or the nearest security section, and update the AGENTS.md project status paragraph.

### Scope Boundaries

- No new runtime control. If a case finds a gap, record it, as the stop conditions say.
- No real model, no model-quality scoring and no third-party corpus import. AGENTS.md forbids adapting outside code.
- MCP coverage uses the existing reference server package unchanged. New admin controls live only in `tests/conformance/support/`. Changing anything under `examples/mcp-server` is a stop condition.

### Assumptions

- The conformance support already provides span serialization, the MCP global setup and admin registry, and a scripted chat model to model the attacker on. The URL- and body-recording network recorder is new work in U1.
- `requestInteraction` and the interaction URL policy reject non-allowlisted URL candidates before any pending state exists, as `interaction-policy.test.ts` shows.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A compromised model, not a defended one.** Asserting on SDK outcomes with an obedient attacker makes the corpus deterministic and tests what galaxie promises. Model robustness belongs to the model, not to galaxie.
- KTD2. **Data-driven cases.** A JSON corpus with closed directive kinds lets reviewers add attacks without new code, and the schema keeps directives from turning into arbitrary scripts.

### Output Structure

```text
tests/injection-corpus/README.md
tests/injection-corpus/cases.json
tests/conformance/support/obedient-attacker.ts
tests/conformance/support/injection-fixture.ts
tests/conformance/support/injection-network.ts
tests/conformance/injection-corpus.test.ts
docs/security-review.md
```

If `cases.json` lives outside `tests/conformance`, the Chromium project (rooted at `tests/conformance`) must still load it. Use a relative import, plus a `server.fs.allow` entry if Vite needs one, and check that both projects run it.

### Implementation Constraints

- New TypeScript files carry the SPDX header. JSON and Markdown follow the license checker's rules; check `scripts/check-license.ts`.
- Biome formats `cases.json`.
- Tests never contact a host other than the loopback reference servers.

## Implementation Units

- **U1. Harness.** R3, R4, the injection network recorder, the corpus MCP server and its admin action, plus a smoke test with one benign case.
- **U2. Corpus and runner.** R1, R2, R5 and R6.
- **U3. Security review.** R7.
- **U4. Links and status.** R8.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test`, with the corpus running in Node and Chromium | before the PR |
| No product change | `git diff --stat main -- packages examples` lists no source file outside test directories. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- Every corpus case passes in both projects, or is a recorded `test.fails` gap named in the pull request.
- The security review is committed.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §9.5–§9.7, §11, the AT-25 to AT-28 and AT-32 rows, and §16.6.
- ADR-0002, ADR-0006, ADR-0012, ADR-0014 and ADR-0016.
- `tests/conformance/` (`confirmations.test.ts`, `mcp.test.ts`, `interaction-policy.test.ts`, `no-network.test.ts`, `output-safety.test.ts`) and `support/`.
- OWASP Top 10 for LLM Applications 2025 (LLM01 Prompt Injection to LLM10 Unbounded Consumption), cited by name only.
