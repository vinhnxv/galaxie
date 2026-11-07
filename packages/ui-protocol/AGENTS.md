# @galaxie/ui-protocol: coding guidance

## Purpose

Own pure A2UI parsing, catalog validation and materialized surface reduction.
See [README](README.md) and [package boundaries](../../docs/system-design.md#4-packages-and-dependency-rules).

## Entry points

The public root is `src/index.ts`; no subpaths are public. `parseMessage`,
`reduceBatch` and `validateSurface` return content-free fixed failures.

## Do

Preserve the pinned specification, deterministic validation order, atomic batches,
revision counter and deletion markers. Validate against caller-owned catalogs,
limits, extension schemas and URL policy. Keep schemas synchronous and data plain JSON.

## Never

Import another package, including core or React. Use network, storage, platform
globals, timers or randomness. Execute catalog functions or trust message-supplied
bindings. Add labels, view revisions, checkpoint writes or renderer behavior here.

## Limits

This package checks protocol structure and catalog rules, not application authority.
Core integration, private-value URL scanning and action data-model validation are
not implemented here. The validator is not a security guarantee.

## Tests

Run `pnpm exec vitest run packages/ui-protocol` in Node and Chromium, the URL,
dependency and package-pack conformance tests, then `pnpm check`.
