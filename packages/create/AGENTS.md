# @galaxie-ai/create: coding guidance

## Purpose

Own the private repository CLI and dependency-free composer for starter layers.

## Entry points

- [src/index.ts](src/index.ts) exports layer loading, composition, path validation and writing.
- [README.md](README.md) describes this private, unpublished package.

## Do

Use `.js` relative imports, explicit exported return types and the repository SPDX header.
Validate the entire composition and target before writing. Preserve existing instruction files.

## Never

Do not publish this package, add runtime dependencies, follow output symlinks or replace existing files.
Do not load layers from the network or add a YAML parser.

## Limits

Layers currently live in this checkout. Tarball installs support npm only; other managers remain unproven.
Filesystem checks and exclusive creates do not establish isolation from other processes with write access.

## Tests

From the repository root, run `pnpm exec vitest run --project node packages/create/test`.
Run both compiler chains and `pnpm check` before reporting completion.
