# @galaxie/adapter-kit: coding guidance

## Purpose

Own shared adapter translation helpers without registering an executor.
See [README](README.md) and the [package boundaries](../../docs/system-design.md#4-packages-and-dependency-rules).

## Entry points

The public root is `src/index.ts`; there are no public subpaths. Helpers cover
tool-call text, selected-provider resolution and pure bridge framing/validation.

## Do

Preserve each caller's validation order and acceptance rules. Use core public
exports and erased LangChain types only. Keep credentials in the factory argument.
Use shared conformance fixtures and keep all adapter goldens unchanged.

## Never

Import an adapter, a framework runtime, core internals or Node-only dependencies.
Read DOM/Worker globals at import time, start Workers or install listeners.
Move executor lifecycle, routing policy or protocol envelopes into this package.

## Limits

This internal building block has no stable standalone API promise. It shares
the launch release version. Prepare-time validation and error helpers remain
adapter-owned; persistence and lease settlement are outside this package.

## Tests

Run `pnpm exec vitest run --project node packages/adapter-kit/test` and the
Chromium lane, then `pnpm check`. Do not regenerate goldens or matrices.
