# ADR-0017: Framework-neutral contracts, with an adapter per framework

- **Status:** Accepted (founder decision, 2026-10-28)
- **Date:** 2026-10-28
- **Related:** brief §0.2, §2, §7.5, §7.6, §16.3, §20; ADR-0001, ADR-0011, ADR-0012, ADR-0016

## Context

The founder wants galaxie to define how browser agents work, not only to host LangGraph.js: how agents communicate, the protocols they use, the security rules and the layers. The contracts should work with LangChain, LangGraph and other frameworks.

ADR-0001 keeps the executor adapter contract engine-neutral. Nothing yet stops LangGraph types from leaking into `core`, and nothing says which parts galaxie specifies itself and which it takes from existing protocols.

Open protocols already cover parts of the problem: MCP for tools, OpenTelemetry for traces, JSON Schema for data shapes, the OpenAI-compatible wire format for remote models, and AG-UI, A2UI and MCP Apps for agent UI. A2A covers communication between agents that run in different places [S48].

## Decision

- galaxie's contracts are a framework-neutral standard for browser agents. Brief §7.6 lists the layers and what galaxie specifies for each.
- galaxie specifies only what no open protocol covers: the host-side lifecycle, capability grants, data labels and argument shapes, UI surfaces, pending-interaction recovery, and how policy applies across them. Elsewhere it reuses MCP, OpenTelemetry, JSON Schema and the OpenAI-compatible wire format, and it bridges UI protocols through adapters.
- `core` holds the contracts and imports no agent framework. Each framework gets its own executor adapter; LangGraph.js is the first (ADR-0001).
- An adapter shows that it implements the standard, and that its framework keeps its native behavior, by passing the conformance suite for that framework (ADR-0016).
- The security baseline (ADR-0012) is part of the standard. An implementation that drops one of its guarantees does not implement the standard.
- Agents inside one graph communicate through their framework's own mechanisms. Separate agent instances in one runtime reach each other only through capabilities the host binds. Agents that run elsewhere, for example over A2A, stay on the watch list (brief §16.8).

## Alternatives considered

- **LangGraph.js as the only framework, with its types in `core`.** Rejected: it ties every host and agent author to one framework and its release cycle.
- **A new agent-authoring framework or graph DSL.** Rejected: developers keep their frameworks (ADR-0001).
- **One existing protocol for everything, such as AG-UI or A2A.** Rejected: none covers capability grants, data labels, recovery of pending interactions and host-owned UI surfaces together. galaxie bridges to them instead.

## Consequences

- LangGraph-specific mapping lives in the adapter package. A `core` type that names a framework concept is a bug.
- The standard needs a version for the set as a whole, beyond the versions of single capabilities and catalogs. How that works is open (brief §20).
- "Standard" here means a published specification with conformance tests. It does not mean a standards-body process, and the docs do not claim one.

## Verification

- M1: `core` builds and passes its tests with no agent-framework import, and a dependency check in CI keeps it that way.
- When a second framework adapter is built, it passes its conformance suite without changes to the core contracts.

[S48]: https://a2a-protocol.org/latest/
