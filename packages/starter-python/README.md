# @galaxie-ai/starter-python

Prepared for the 0.2.0 release; not yet published. APIs may change in a 0.x minor release.

LangGraph Python starter wheels and Node build helpers, included in public-package size budgets. It contains no
agent source or Pyodide runtime binaries; the manifest records the pinned npm
runtime's lengths and hashes for the framework overlay.

Prepack checks the runtime version and adapter-declared lengths, then computes
SHA-256 hashes from the maintainer's installed, pinned npm `pyodide` package.
These are inventory hashes from that installation, not independent upstream hash
pins. They rely on the maintainer's package installation and manifest provenance.

The root entry advertises the package version and reads its distribution manifest.
The `@galaxie-ai/starter-python/build` entry provides `verifyArtifact`,
`fileMetadata` and `verifyDist`. Release verification compares the distribution to
the build's expected manifest, checks the package version, refuses symlinked files
and checks every wheel and the generated notices. Hashes establish a match to the
expected inventory, not authenticity if both files and trusted metadata are replaced.

## Install

After the maintainer publishes, use `npm install @galaxie-ai/starter-python@0.2.0`. Until then, use repository-built npm tarballs. The whole lockstep release waits for the maintainer's Python license review described in the [release guide](../../docs/releasing.md#prepared-adapters), including the unmodified registry Pyodide MPL-2.0 exception.

The pack test verifies distribution contents and versions; repository `create-clean` CI and local standalone runs exercise generated projects with mocks and npm tarballs. Registry installs of 0.2.0, real models, devices, Yarn tarball mode for this framework and non-Linux CI remain unverified.

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

Prepack compares both local wheels' complete `.py` inventories and bytes with
`python/galaxie/src` and `python/standins/ormsgpack/src`, refusing changed, missing
or extra modules with the wheel filename and rebuild command. The trusted local
build inventory also records each package's `pyproject.toml` SHA-256, so edited
metadata inputs or an older inventory without those hashes require a wheel
rebuild. This checks build-input freshness; it does not independently reproduce
setuptools' metadata or establish authenticity when the trusted inventory is
replaced. Bit-for-bit local-wheel reproducibility and compatibility with a newer
adapter bridge are not established.

Plain `vite dev` watches `python/agent` and invalidates both the served assets
and virtual source identity after edits, additions and removals. The generated
`dev` script still builds and previews; rerun it after editing sources.
`fflate` is a development dependency used only when preparing the distribution.
The tarball excludes the build-only `notices` and `sources` modules and their
declarations and maps; prepack still compiles and uses them in the checkout.

## Notices and limits

`dist/NOTICE.txt` retains wheel metadata, license files and notices. Pack accepts
the repository's permissive license identifiers and only the named exceptions
in `src/notices.ts`. It flags `certifi` MPL-2.0 and the MPL-2.0 text that `orjson`
ships beside Apache/MIT. Both require maintainer review before redistribution.

`ormsgpack` is a limited same-name stand-in, not upstream. Repository metadata
says Apache-2.0; **license to be confirmed by the maintainer**. Its
[source header](../../python/standins/ormsgpack/src/ormsgpack/__init__.py) describes
it as independently written and says no upstream implementation is included.
Serializer compatibility is
unverified, and replacing it may make saved checkpoints unreadable. Nothing in
this package resolves that license or checkpoint-format decision.

The framework overlay supports both kinds. Chromium acceptance and the npm
tarball standalone harness pass with Python and uv absent from PATH; see the
[measurement record](../../docs/standalone-verification.md). Python is trusted
author code; no new isolation boundary is claimed.
ADR-0012 guarantees are unchanged. Real models, Firefox/WebKit, Yarn
standalone installs for this framework, Node 22 for this framework and Pyodide startup time are unmeasured; Ubuntu Node 24 cold runs are recorded in the standalone record.

Run `pnpm exec vitest run --project node tests/conformance/starter-python-dist.node.test.ts`
and both repository typechecks. Distribution tests use owned temporary packages
and skip locally with a reason when the cache is absent; CI refuses that absence.
