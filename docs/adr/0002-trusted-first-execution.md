# ADR-0002: Trusted-first execution in v0.1

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** brief §9.1, §9.9; ADR-0012

## Context

The vision includes sharing and reusing agents, which eventually means running code the host did not write. In a browser, JavaScript running in the app's origin can call `fetch`, read storage and touch the DOM directly. A wrapper API or manifest cannot stop code that never calls the wrapper. A Web Worker runs on another thread but can still call `fetch`; Shadow DOM is styling encapsulation, not a security boundary.

## Decision

- In v0.1, galaxie runs only JS/TS agents that the developer reviewed, trusts and bundles into the application.
- The capability broker controls the calls that go through it. It is not described as a sandbox.
- No "install from URL" or runtime code loading.
- Untrusted code needs its own ADR and threat model before any support: an isolated-origin sandbox or a WASM guest with narrow host imports, a checked message bridge, resource limits, and escape and egress tests.

## Alternatives considered

- **Worker-based "sandbox".** Rejected: workers have network access.
- **SES/Hardened JavaScript compartments now.** Deferred: promising, but adds complexity and does not cover every browser API path without careful review; evaluate in the isolation phase.
- **Isolated-origin iframe per agent now.** Deferred: it is the likely isolation design, but it makes host capabilities, model sharing and UI rendering cross-origin RPC from day one.

## Consequences

- Supply chain hygiene (lockfiles, integrity, review, provenance) is the defense against malicious packages in v0.1.
- Docs and marketing must never call the manifest or the broker a sandbox (AT-11).
- A registry or marketplace cannot ship before the isolation phase (brief §16.7, Phase 7).

## Verification

- AT-11 and the review prompt item about sandbox claims.
- A docs review before release checks the wording.
