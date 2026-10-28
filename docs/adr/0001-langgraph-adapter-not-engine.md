# ADR-0001: Run LangGraph.js through an adapter; no new engine

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** brief §0.2, §7; ADR-0003, ADR-0004, ADR-0005

## Context

Galaxie agents need real graph semantics: branching, loops, subgraphs, reducers, interrupts and checkpoints. LangGraph.js already provides them, has a browser export and runs browser tests in its repository. Developers the project targets already write LangGraph agents.

Building a second graph engine would duplicate that work. It would also create two owners of "which node runs next", which is the most likely source of subtle recovery bugs.

## Decision

- Galaxie runs LangGraph.js itself through an executor adapter.
- LangGraph owns graph state, reducers, scheduling, supersteps, subgraphs and checkpoint semantics.
- Galaxie owns identity, lifecycle, model and tool services, storage integration, budgets, public state projection and UI surfaces.
- Galaxie never reads a checkpoint to decide the next node.
- The executor adapter contract (brief §7.5) stays engine-neutral, so other engines can be added later as trusted infrastructure code.

## Alternatives considered

- **Own graph kernel in TypeScript or Rust.** Rejected for the MVP: large effort, no measured need, and it splits the ecosystem.
- **Compile LangGraph graphs to WASM.** Rejected: `compile()` produces a runtime object with closures, not a portable artifact.
- **State machines only (XState/Stately Agent).** Not chosen as the default; a separate adapter later if users ask.
- **Remote LangGraph server with a browser client.** Rejected as the main path: it is not local execution. It stays reachable as a "remote" tier.

## Consequences

- Galaxie depends on LangGraph.js versions. Versions are pinned, and a compatibility matrix records observed browser behavior.
- The browser has no `AsyncLocalStorage`; some APIs may need an explicit `config`. Spike A lists them.
- There is no official browser checkpointer; ADR-0005 covers it.
- Node re-execution on resume is LangGraph behavior that galaxie must design around (ADR-0004).

## Verification

- Spike A: branch, subgraph, interrupt/resume and reload on the pinned version.
- AT-01, AT-02, AT-15.
