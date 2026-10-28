# Architecture Decision Records

Each ADR records one decision for galaxie: the context, the decision, the alternatives, the consequences and how the decision will be verified. The project brief ([`../galaxie-project-brief.md`](../galaxie-project-brief.md)) summarizes the decisions; the ADRs hold the reasoning.

## Statuses

- **Proposed:** the working default. A spike or milestone must confirm or revise it.
- **Accepted:** decided. Changing it needs a new ADR that supersedes it.
- **Superseded by ADR-NNNN:** replaced; kept for history.
- **Rejected:** considered and not adopted; kept so the question is not reopened without new evidence.

## Rules

- Until M1 starts, any ADR may be revised in place. Each revision adds a dated entry to a **Revisions** line in the header.
- After M1 starts, an Accepted ADR's decision changes only through a new ADR that marks the old one Superseded. New evidence may still be appended to its Verification section.
- A Proposed ADR may be edited as evidence arrives. Record the evidence in its Verification section.
- Every ADR names the test, spike or metric that verifies it.
- File names are `NNNN-short-kebab-title.md`. ADRs are written in English.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-langgraph-adapter-not-engine.md) | Run LangGraph.js through an adapter; no new engine | Accepted |
| [0002](0002-trusted-first-execution.md) | Trusted-first execution in v0.1 | Accepted |
| [0003](0003-executor-execution-context.md) | Executor on the main thread in the MVP | Proposed |
| [0004](0004-interrupt-as-pending-interaction-source.md) | Checkpoint interrupt is the source of truth for pending interactions | Proposed |
| [0005](0005-indexeddb-checkpoint-saver.md) | IndexedDB checkpoint saver for LangGraph.js | Proposed |
| [0006](0006-model-providers-and-routing.md) | Model providers, destination classes and per-role routing | Accepted |
| [0007](0007-typed-ui-registry-for-mvp.md) | Typed UI registry with headless reference components | Proposed |
| [0008](0008-code-first-agent-definition.md) | Code-first agent definition, generated manifest | Proposed |
| [0009](0009-multi-tab-ownership.md) | Multi-tab ownership with Web Locks and a fencing epoch | Proposed |
| [0010](0010-mvp-scope-cuts.md) | MVP scope cuts | Proposed |
| [0011](0011-mcp-via-controlled-servers.md) | MCP and remote tools through servers the project controls | Accepted |
| [0012](0012-security-baseline.md) | Mandatory security baseline | Accepted |
| [0013](0013-typescript-first-implementation.md) | TypeScript-first implementation language | Accepted |
| [0014](0014-data-labels-and-argument-shapes.md) | Run-level data labels and argument shapes | Proposed |
| [0015](0015-licensing-agpl-with-commercial-license.md) | License: AGPL-3.0 with a commercial license | Accepted |

## Template

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN | Rejected
- **Date:** YYYY-MM-DD
- **Related:** brief §x.y, ADR-NNNN

## Context

## Decision

## Alternatives considered

## Consequences

## Verification
```
