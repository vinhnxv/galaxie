# @galaxie-ai/starter-python

Prepared for the 0.2.0 release; not yet published. APIs may change in a 0.x minor release.

LangGraph Python starter wheels and Node build helpers, included in public-package size budgets. It contains no
agent source or Pyodide runtime binaries; the manifest records the pinned npm
runtime's lengths and hashes for the framework overlay.

The root entry advertises the package version and reads its distribution manifest.
The `@galaxie-ai/starter-python/build` entry provides `verifyArtifact`,
`fileMetadata` and `verifyDist`. Release verification compares the distribution to
the build's expected manifest, checks the package version, refuses symlinked files
and checks every wheel and the generated notices. Hashes establish a match to the
expected inventory, not authenticity if both files and trusted metadata are replaced.

## Install

After the maintainer publishes, use `npm install @galaxie-ai/starter-python@0.2.0`. Until then, use repository-built npm tarballs. The whole lockstep release waits for the maintainer's Python license review described in the [release guide](../../docs/releasing.md#prepared-adapters), including the unmodified registry Pyodide MPL-2.0 exception.

The pack test verifies distribution contents and versions; repository `create-clean` CI and local standalone runs exercise generated projects with mocks and npm tarballs. Registry installs of 0.2.0, real models, devices, pnpm/yarn tarball mode and non-Linux CI remain unverified.

## Prepare and pack

From the repository root, prepare the wheel cache with the existing tools:

```sh
node scripts/fetch-python-wheels.ts
uv sync --project python --locked
node scripts/build-python-wheels.ts
pnpm --filter @galaxie-ai/starter-python run prepack
```

Only cache preparation needs uv and the pinned Python environment. Prepack never
downloads or builds a wheel and needs neither Python nor uv. It derives the
LangGraph lane from the adapter's `runtime-files` export and adds exactly the
`galaxie` and `ormsgpack` local wheels in `local-wheels.json`. The vendored
`cryptography` wheel and the other framework lanes are excluded. A missing,
truncated or changed wheel fails with its filename and leaves no complete manifest.
It never repairs the cache. Output is ordinary ignored build output under `dist/`.

Local wheels may be stale if their sources changed after cache preparation.
Their hashes are recorded, but bit-for-bit reproducibility and compatibility
with a newer adapter bridge are not established.

## Notices and limits

`dist/NOTICE.txt` retains wheel metadata, license files and notices. Pack accepts
the repository's permissive license identifiers and only the named exceptions
in `src/notices.ts`. It flags `certifi` MPL-2.0 and the MPL-2.0 text that `orjson`
ships beside Apache/MIT. Both require maintainer review before redistribution.

`ormsgpack` is a limited same-name stand-in, not upstream. Repository metadata
says Apache-2.0; **license to be confirmed by the maintainer**. It is independently
written with no copied upstream implementation. Serializer compatibility is
unverified, and replacing it may make saved checkpoints unreadable. Nothing in
this package resolves that license or checkpoint-format decision.

The framework overlay supports both kinds. Chromium acceptance and the npm
tarball standalone harness pass with Python and uv absent from PATH; see the
[measurement record](../../docs/standalone-verification.md). Python is trusted
author code; no new isolation boundary is claimed.
ADR-0012 guarantees are unchanged. Real models, Firefox/WebKit, pnpm/yarn
standalone installs, Node 22 for this framework and Pyodide startup time are unmeasured; Ubuntu Node 24 cold runs are recorded in the standalone record.

Run `pnpm exec vitest run --project node tests/conformance/starter-python-dist.node.test.ts`
and both repository typechecks. Distribution tests use owned temporary packages
and skip locally with a reason when the cache is absent; CI refuses that absence.
