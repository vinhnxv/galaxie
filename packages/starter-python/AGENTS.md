# Starter Python agent guidance

## Purpose

Own the private LangGraph-lane wheel distribution and build-time verification.

## Entry points

The package root reads its manifest; `src/build.ts` exports build helpers.

## Do

Keep the wheel set derived from the adapter inventory.
Prepack only reads the prepared wheel cache. Verify every byte count and SHA-256,
keep filename-specific failures, and never repair or download cache entries here.
Preserve full wheel license texts and the certifi/orjson MPL-2.0 review flags.
The limited same-name ormsgpack stand-in is not upstream: its license is to be
confirmed by the maintainer. Never silently treat its serializer as compatible.
Build test distributions only in owned temporary directories. Source hashing and
framework overlays belong to the next implementation stage.

## Never

Import a galaxie runtime or adapter package here, publish this package, repair or
download cache entries during prepack, or weaken ADR-0012 controls.

## Limits

Local-wheel reproducibility, serializer compatibility and bridge-version binding
are not established. Hashes require trusted metadata; they do not authenticate
a distribution when both artifacts and metadata can be replaced.

## Tests

Run the distribution conformance tests, package inventories and both repository
typechecks. The cache is required in CI; local absence skips with a reason.
