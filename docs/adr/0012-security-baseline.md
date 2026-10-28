# ADR-0012: Mandatory security baseline

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** brief §5.4, §9.6–§9.9, §17; ADR-0002, ADR-0006, ADR-0011, ADR-0014, ADR-0016
- **Revisions:**
  - 2026-10-28, after an external read-only review and before any implementation:
    - guarantees scoped to SDK-controlled paths;
    - trace allowlist instead of redaction;
    - approvals bound to parameters;
    - attribution header is not authorization;
    - logout invalidation generation;
    - B10 and B11 added.
  - 2026-10-28, with brief 0.3: B3 also covers tracing credentials, because spans leave through an exporter the host registers (ADR-0016).

## Context

Galaxie agents read the user's data, act with the user's session, render UI inside the host app and reach other servers. Prompt injection cannot be reliably blocked by prompts or filters. A run that combines private data, untrusted content and an outbound channel must be assumed able to leak (the "lethal trifecta").

Trusted-first execution (ADR-0002) means an XSS bug or a malicious dependency bypasses client-side controls. Server-side authorization and CSP then limit the damage. The founder asked which mechanisms developers and users must follow strictly.

## Decision

The baseline in brief §9.7 is mandatory and a release condition:

- **A. Runtime guarantees with no off switch.** They hold on SDK-controlled paths (model router, broker, MCP client, renderer, galaxie storage), not on code that bypasses the SDK:
  1. no model-produced HTML/JS, and URL allowlists;
  2. deny-by-default capabilities with request and response validation;
  3. no generic `fetch`, SQL or shell capability;
  4. credentials galaxie handles never enter prompts, state, checkpoints, traces or exports; traces keep allowlisted fields only;
  5. host-rendered confirmations for significant actions, with approvals bound to principal, capability, canonical arguments, effect ID, policy revision and expiry, single use;
  6. no silent change of inference destination, and data labels enforced (ADR-0014);
  7. finite default budgets;
  8. an agent attribution header on every broker request, for attribution only, never as authorization;
  9. pinned MCP definitions;
  10. logout with a cross-tab invalidation generation, a wipe of principal data and invalidation of in-flight results and approvals.
- **B. Host developer obligations:**
  1. server-side authorization on every request;
  2. strict CSP with Trusted Types;
  3. no provider keys or tracing credentials in bundles;
  4. narrow capabilities with idempotency keys;
  5. no password or payment components in a catalog;
  6. MCP only through servers the host controls;
  7. only reviewed, bundled agents;
  8. authoritative scores and transactions on the server;
  9. the injection corpus in CI;
  10. short-lived tokens scoped to the agent's capabilities for write capabilities;
  11. spending limits enforced on the host proxy.
- **C. Agent author obligations:**
  - no direct `fetch`, storage, DOM or `eval`, checked by the ESLint plugin (a linting aid, not enforcement);
  - deterministic permission and grading logic;
  - side effects after interrupts;
  - tool output treated as data.
- **D. End users are not a security layer.** Docs give advice only: spending-limited keys, agents never ask for passwords, exact `OLLAMA_ORIGINS`, Local Network Access only for trusted sites.

Removing an item from A, B or C needs a superseding ADR. Adding items needs only an update to this ADR and the brief.

## Alternatives considered

- **Guardrail model or prompt filters as the main defense.** Rejected: probabilistic; useful only as an extra layer.
- **Leave security to host developers.** Rejected: the most likely integrators, including people coding with AI assistants, will copy the defaults. The defaults must be safe.

## Consequences

- Some convenient features are impossible by design: a raw-key provider parameter, a generic fetch tool, rendering model HTML.
- Tests AT-21, AT-23 to AT-30, AT-32 and AT-33 are part of the release gate.
- Residual risks are documented, not hidden:
  - code that bypasses the SDK;
  - paraphrased private data sent to allowed destinations;
  - behavior changes behind an unchanged MCP definition.
- Security review results are reported as "no findings in scope X", never as "secure".
- Acceptance tests map to the OWASP Top 10 for LLM Applications.

## Verification

- M1 covers A1–A4, A7 and A8 with tests; M2 to M4 cover the rest.
- The M4 security review against this ADR.
- The injection corpus runs in CI.
