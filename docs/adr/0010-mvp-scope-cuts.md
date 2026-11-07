# ADR-0010: MVP scope cuts

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §5, §16; ADR-0006, ADR-0011, ADR-0016, ADR-0017
- **Revisions:** 2026-10-28, with brief 0.3: trace spans and the parity conformance suite join the MVP (ADR-0016); the published CLI stays cut; adapters for other frameworks are cut (ADR-0017); the executor worker row states the MVP exception from ADR-0003. 2026-11-07: [ADR-0027](0027-a2ui-surfaces.md) proposes to supersede the registry-format decision and lift the A2UI deferral; this ADR's status is unchanged until ADR-0027 is accepted.

## Context

The v0.1 MVP mixed the core proof (reuse, local execution, interactive UI, recovery) with items that do not test the core hypotheses but cost real time. Founder decisions on 2026-10-28 also added two items back: remote LLM providers (ADR-0006) and an MCP client for servers the project controls (ADR-0011).

## Decision

Cut from the MVP, with the phase where each item can return (brief §16.7). The executor worker is the one exception: it returns during the MVP if its measured trigger fires (ADR-0003).

| Item | Reason | Returns in |
| --- | --- | --- |
| Dedicated executor worker | No measured need (ADR-0003) | Phase 6, or during the MVP under a superseding ADR if the main-thread trigger fires (ADR-0003) |
| Multi-model pool, shared engine across tabs | One model and one tab cover the slice | Phase 6 |
| json-render, A2UI, MCP Apps renderers | Typed registry covers graph-selected UI (ADR-0007) | Phase 6 |
| LLM-composed UI | Needs strong models and tighter policy | Phase 6 |
| Published CLI | A build script is enough | Phase 6 |
| Executor adapters for frameworks other than LangGraph.js | One adapter proves the contracts, which stay framework-neutral (ADR-0017) | After the MVP, once the next framework is chosen (brief §20) |
| Third-party MCP with OAuth 2.1 | Token storage and consent need their own design | Phase 5 |
| OpenAPI import as capabilities | No host needs it yet | Phase 5 |
| BYOK direct to OpenAI/Anthropic | Key exposed to every script on the origin | Phase 5, behind its own ADR |
| Voice | Text loop first | Phase 5 |
| Untrusted packages, registry | Needs the isolation phase (ADR-0002) | Phase 7 |

Added to the MVP compared with v0.1:

- the OpenAI-compatible provider (host proxy and user endpoint);
- Chrome Built-in AI;
- the MCP client with an allowlist and pinning;
- the security baseline tests;
- the per-user writing step;
- the parity conformance suite on Node and in Chrome (ADR-0016);
- OpenTelemetry trace spans, with the exporter registered by the host (ADR-0016).

## Alternatives considered

- **Keep the v0.1 scope.** Rejected: the per-user step and the security baseline were missing, and several items did not test any hypothesis.

## Consequences

- The MVP is narrower on renderers and tooling and broader on providers and security.
- Each cut item needs its entry gate met before it returns.

## Verification

- M4 release gate: no cut item ships without its gate; scope is reviewed against the cut list before release.
