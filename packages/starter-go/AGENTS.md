# Starter Go agent guidance

## Purpose

Own the starter artifacts and build-time helpers. Prepared for the 0.2.0 release; not yet published. APIs may change in a 0.x minor release. The Go author source lives only in the framework template.

## Entry points

`src/index.ts` is the manifest entry; `src/build.ts` is the build helper entry.

## Do

Preserve deterministic source hashing, exact toolchain selection and verified artifact digests. Run the starter conformance tests.

## Never

Import a galaxie runtime or adapter package, duplicate the author Go source, or weaken ADR-0012 controls.

## Limits

The package builds trusted author code. It does not provide an isolation boundary or download a Go toolchain.

## Tests

Run the source, distribution and resolver conformance tests under `tests/conformance/` and the package typecheck.
