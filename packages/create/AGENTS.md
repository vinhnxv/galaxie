# @galaxie-ai/create: coding guidance

## Purpose

Own the private repository CLI and dependency-free composer for starter layers.

## Entry points

- [src/index.ts](src/index.ts) exports layer loading, composition, path validation and writing.
- [src/guidance.ts](src/guidance.ts) loads the single skill source and renders project guidance.
- [README.md](README.md) describes this private, unpublished package.

## Do

Use `.js` relative imports, explicit exported return types and the repository SPDX header.
Validate the entire composition and target before writing. Preserve existing instruction files.
Keep guidance in [skills/galaxie](../../skills/galaxie/README.md), with citations checked by `check:docs`.
Render bounded summaries and identical real-file skill copies through the composer's existing add path.

## Never

Do not publish this package, add runtime dependencies, follow output symlinks or replace existing files.
Do not load layers from the network or add a YAML parser.
Do not duplicate guidance in templates, change CSP/Trusted Types output or add guidance to the composed test cache.

## Limits

Layers currently live in this checkout. Tarball installs support npm only; other managers remain unproven.
Filesystem checks and exclusive creates do not establish isolation from other processes with write access.
Agent consumption of the skill, release-tag installation and Windows installer behavior are unmeasured.

## Tests

From the repository root, run `pnpm exec vitest run --project node packages/create/test`.
Also run `pnpm exec vitest run --project node tests/conformance/skill-install.node.test.ts tests/conformance/check-docs.node.test.ts` and `pnpm run check:docs`.
Run both compiler chains and `pnpm check` before reporting completion.
