# @galaxie-ai/starter-go

## Purpose

Prepared for the 0.2.0 release; not yet published. APIs may change in a 0.x minor release.

Go starter artifacts and Node build helpers. The template Go source is owned by `templates/frameworks/adk-go/files/go/` in the repository.

## Install

After the maintainer publishes, use `npm install @galaxie-ai/starter-go@0.2.0`. Until then, use repository-built npm tarballs. The pack test verifies distribution contents and versions; generated Go projects pass mock-backed npm tarball standalone runs without Go on their PATH. Registry installs of 0.2.0, real models, devices, pnpm/yarn tarball mode and non-Linux CI remain unverified.

## Entry points

The package root advertises its version and reads its distribution manifest. `@galaxie-ai/starter-go/build` provides source hashing and deterministic build helpers.

## Do

Use Go 1.27.3 on PATH to edit and compile the agent. Keep the template dependency versions aligned with the repository Go module.

## Never

Download a toolchain automatically or change the host's CSP or Trusted Types baseline.

## Limits

Local builds can download modules through the developer's GOPROXY and verify them with go.sum; offline builds are not promised. The prebuilt agent covers the byte-identical template source only. A release that changes the template Go tree requires Go for older projects until their source is updated. npm directory layouts and pnpm symlink layouts are supported; Yarn requires `nodeLinker: node-modules`. Bun and Windows are unsupported.

Source identity covers every regular file under `go/` except `.git`, `.DS_Store` and `node_modules`, so hidden and underscore-prefixed Go packages and embedded inputs invalidate the cache. Symlinks and non-regular files are refused.

Local `go.mod` replacement targets must stay inside that hashed `go/` tree, outside its ignored directories. The one external exception is `../node_modules/@galaxie-ai/starter-go/dist/go-module`, whose digest is checked against the package manifest. Other local targets, including other modules under `node_modules`, are rejected before cache lookup or compilation. Move a local module into `go/`, or use a versioned module dependency with `go.sum`. Quoted paths are supported; double-quoted paths must use JSON-compatible escapes.

For unchanged template source, every cache hit is rehashed against the packaged manifest's wasm digest and length; the sidecar cannot authorize different bytes. Edited-source cache entries have no release digest: their sidecars detect incomplete writes or accidental corruption only. Protect the project and its `node_modules/.cache/galaxie-go` directory from other writers. Someone who can replace both an edited wasm and its sidecar can replace that cached build; delete the cache and rebuild with the pinned Go toolchain if its provenance is in doubt. Owner checks and signed local-build manifests are not provided. Package manifests must themselves come from trusted build output; replacing both a package artifact and its manifest is outside these digest checks.

Edited source without the pinned toolchain fails with this exact message:

> The agent source in go/ was edited and Go 1.27.3 was not found on PATH. Install Go 1.27.3, or restore the original go/ source to use the prebuilt agent.

## Tests

Run `pnpm exec vitest run --project node tests/conformance/starter-go-source.node.test.ts` from the repository root. Browser integration belongs to the framework overlay and is not supplied by this package alone.
