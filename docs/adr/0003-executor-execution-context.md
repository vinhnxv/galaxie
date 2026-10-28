# ADR-0003: Executor on the main thread in the MVP

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §6.1, §6.2, §18; ADR-0001, ADR-0009, ADR-0016
- **Revisions:** 2026-10-28, with brief 0.3: the M1 conformance suite replaces Spike A; the long-task trigger is watched from M2, when real inference runs (ADR-0016).

## Context

The v0.1 brief placed LangGraph.js in a dedicated "executor worker". Most of the executor's time is spent waiting: on inference, on capabilities and on the user. The heavy work, inference, already runs in its own worker.

Host capabilities hold the app's session and live on the main thread. In a worker, every capability, UI intent and storage call becomes an RPC proxy with serialization rules, identity checks and error mapping. That is a large surface to build and test, for a benefit nobody has measured.

## Decision

- In the MVP the executor runs on the main thread, in the same context as the host.
- WebLLM or Transformers.js inference runs in a dedicated worker.
- Built-in AI is called from the page, because the Prompt API is not available in workers. The browser runs that model outside the page.
- Move the executor to a dedicated worker or a `SharedWorker` only when a measured trigger fires: a galaxie-attributed main-thread long task over 50 ms during normal runs on a reference device (brief §18). If the trigger fires during the MVP, the move becomes MVP work under a superseding ADR; it does not wait for Phase 6.
- A service worker is not used for the executor, because the browser can stop it at any time.

## Alternatives considered

- **Dedicated worker per runtime (v0.1 proposal).** Deferred until the trigger fires.
- **`SharedWorker` as a cross-tab owner.** Deferred: it would also solve multi-tab ownership, but support and debugging are weaker, and ADR-0009 solves ownership with Web Locks.
- **Service worker.** Rejected: unsuitable lifetime.

## Consequences

- No RPC layer between host and executor in the MVP; capabilities are direct calls through the broker.
- Execution is cooperative. Budgets, cancellation, timers and epoch checks cannot preempt a synchronous loop on the main thread.
  - Graph code must stay non-blocking; heavy synchronous work in nodes is a bug.
  - Synchronous inputs (schema validation, reducers, serialization) are size-bounded.
  - Measurements cover the whole interaction path, not only inference.
- The executor adapter must not assume it shares memory with the host, so a later move stays possible: no hidden global state, and capability calls only through `host`.

## Verification

- The M1 conformance suite runs the executor on the browser main thread.
- From M2, when real inference runs, M2 and M3 watch main-thread long tasks (brief §18). If the trigger fires, write a superseding ADR with the measurement.
