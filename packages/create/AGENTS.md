# @galaxie-ai/create: coding guidance

## Purpose

Own the CLI and dependency-free composer for starter layers. Prepared for the 0.2.0 release; not yet published. APIs may change in a 0.x minor release.

## Entry points

- [src/index.ts](src/index.ts) exports layer loading, composition, path validation and writing.
- [src/guidance.ts](src/guidance.ts) loads the single skill source and renders project guidance.
- [README.md](README.md) describes package usage and verification limits.

## Do

Use `.js` relative imports, explicit exported return types and the repository SPDX header.
Validate the entire composition and target before writing. Preserve existing instruction files.
Keep guidance in [skills/galaxie](../../skills/galaxie/README.md), with citations checked by `check:docs`.
Render bounded summaries and identical real-file skill copies through the composer's existing add path.

## Never

Do not add runtime dependencies, follow output symlinks or replace existing files.
Publishing is a manual maintainer step described in [the release guide](../../docs/releasing.md).
Do not load layers from the network or add a YAML parser.
Do not duplicate guidance in templates, change CSP/Trusted Types output or add guidance to the composed test cache.

## Limits

Packed distributions include templates and the galaxie skill; checkout runs fall back to repository sources.
Prepack refreshes these ignored copies, and postpack removes them; `pnpm run clean:pack` also removes them. Tarball installs support npm only; other managers remain unproven.
Filesystem checks and exclusive creates do not establish isolation from other processes with write access.
Agent consumption of the skill, release-tag installation and Windows installer behavior are unmeasured.

## Tests

From the repository root, run `pnpm exec vitest run --project node packages/create/test`.
Also run `pnpm exec vitest run --project node tests/conformance/skill-install.node.test.ts tests/conformance/check-docs.node.test.ts` and `pnpm run check:docs`.
Run both compiler chains and `pnpm check` before reporting completion.
