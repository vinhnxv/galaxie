# ADR-0013: TypeScript-first implementation language

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** brief §0.2, §6.1, §16.8, §16.9; ADR-0002
- **Revisions:**
  - 2026-10-28: TypeScript 7 facts checked against the official announcement, and the side-by-side setup made explicit.
  - 2026-10-28, with brief 0.3: references to M0 removed, because the roadmap no longer has an M0 phase.

## Context

The question is whether to build galaxie in TypeScript or in Rust, and which is safer for a product many developers and users will rely on.

Facts that shape the answer:

- **The runtime is the browser.** Whatever we write runs as JavaScript or as WASM inside the host app's origin. Rust compiled to WASM runs in the same origin, with the same access to the page through its imports.
- **TypeScript 7 is a compiler, not a new runtime.**
  - TypeScript 7.0 shipped on 2026-07-08 with a native compiler written in Go. Microsoft reports large build speedups over 6.0.
  - It aims to match 6.0's type-checking and command-line behavior. It also turns many deprecated options into hard errors.
  - 7.0 ships no compiler API; 7.1 is expected to ship a new and different one. Until then, tools that need the API keep using 6.0 through the `@typescript/typescript6` package or an npm alias, side by side with 7.0. These include type-aware lint rules, declaration bundlers, API extractors, and editor tooling for frameworks such as Vue.
- **The threats in brief §9.6 are authority and logic flaws, not memory corruption.** Confused deputy, injection, exfiltration through rendering, tool poisoning and supply chain attacks are equally possible in Rust and TypeScript. JavaScript is already memory-safe. Rust's main security win, memory safety in native code, does not apply to browser JS.
- **Isolation comes from boundaries, not languages.** An isolated origin, or a WASM guest whose host imports are narrow, is what contains untrusted code. Code in either language can be a guest.
- **The dependencies are TypeScript:** LangGraph.js, LangChain chat models, WebLLM bindings, Transformers.js, the MCP TypeScript SDK and React.

## Decision

- Galaxie is written in TypeScript (strict) for every package in the MVP: core, adapters, models, MCP client, storage and React.
- The toolchain compiles and type-checks with TypeScript 7. Tools that need the compiler API run on TypeScript 6.0, installed side by side as Microsoft recommends, until they support the 7.1 API. Examples are type-aware ESLint rules, declaration bundling and API reports. Verification lists those tools.
- Example servers (`examples/mcp-server/`) and build scripts are TypeScript on Node, so types are shared with the browser packages.
- Rust is not used in the MVP. It is a candidate only where a measured need exists:
  - a WASM guest target for untrusted plugins in the isolation phase (Phase 7);
  - compute kernels that profiling shows are hot and that existing engines do not cover;
  - a high-load gateway, if load tests show the TypeScript gateway is the bottleneck.
- tsrs (`@tsrs/wasm`, a Rust port of the TypeScript 7 compiler running as WASM) stays on the watch list. It is useful only for an in-browser playground; it is a compiler, not a runtime or a sandbox.

## Alternatives considered

- **Rust core compiled to WASM, with TS bindings.** Rejected: adds a JS↔WASM boundary for every capability and UI call, loses direct use of LangGraph.js and LangChain, and does not add security in the same origin.
- **Rust for the security-sensitive parts (policy engine).** Rejected for now: the policy engine's correctness comes from tests and a small surface. Moving it to WASM would not stop same-origin JS from bypassing it (ADR-0002).
- **Stay on TypeScript 6.x only.** Rejected: 7.x is the supported line going forward and is much faster in CI.

## Consequences

- Production safety depends on architecture and process: the security baseline (ADR-0012), supply chain controls, reviews and audits (brief §16.9).
- While the side-by-side setup exists, CI type-checks with both 7.x and 6.0, so the two never disagree silently.

## Verification

- The repository records the TypeScript versions and the tools that still need 6.x.
  - Done (2026-10-28): the workspace pins TypeScript 7.0.2 (`tsc`) and TypeScript 6.0.3 through `@typescript/typescript6` 6.0.2 (`tsc6`). CI type-checks with both.
  - No tool in the toolchain needs the compiler API yet. Biome lints and formats without it, and Vitest runs TypeScript through Vite's own transformer.
  - The first tool that will need 6.x is typescript-eslint, for the agent-package ESLint plugin in M4: version 8.72 supports TypeScript only below 6.1.
- Revisit when Phase 7 isolation work starts, or when profiling shows a hot path.
