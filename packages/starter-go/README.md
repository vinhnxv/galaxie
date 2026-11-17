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

Edited source without the pinned toolchain fails with this exact message:

> The agent source in go/ was edited and Go 1.27.3 was not found on PATH. Install Go 1.27.3, or restore the original go/ source to use the prebuilt agent.

## Tests

Run `pnpm exec vitest run --project node tests/conformance/starter-go-source.node.test.ts` from the repository root. Browser integration belongs to the framework overlay and is not supplied by this package alone.
