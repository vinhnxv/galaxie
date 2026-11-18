# @galaxie-ai/create

CLI and dependency-free composer for starter projects, prepared for the 0.2.0
lockstep release; not yet published. Nothing is published by this preparation. Packed distributions
include the templates and galaxie skill; the built CLI also runs from this checkout.
Public APIs may change in a 0.x minor release.

After the maintainer publishes, create a project with:

```sh
npm create @galaxie-ai@0.2.0 -- my-app browser-only langgraph-js
npm create @galaxie-ai@0.2.0 -- my-app --kind gateway --framework adk-go
```

`npm create @galaxie-ai` selects this CLI; the explicit `@0.2.0` selects the prepared release. Generated `@galaxie-ai/*` dependencies use `^0.2.0` caret ranges. Upgrade all galaxie pins together for a lockstep bump. These registry commands remain unverified until publication; use local tarballs now.

Build it from this checkout using the repository's Node 24 and pnpm 11 tooling:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -p packages/create/tsconfig.build.json
```

From the directory where the project should be created, run the built CLI by its
absolute path. The project directory argument must be relative:

```sh
node /path/to/galaxie/packages/create/dist/cli.js my-app browser-only langgraph-js
node /path/to/galaxie/packages/create/dist/cli.js my-app --kind gateway --framework langgraph-js --no-install
```

Use `.` inside an empty directory whose basename is a lowercase npm package name.
When both input and output are terminals, missing choices are prompted; choose by
name or number, or press Enter for a single available choice. Without a terminal,
provide the directory, kind and framework. Unknown values, repeated choices and
missing non-terminal choices exit with code 2 and list the available values.
Runtime and install failures exit with code 1; success exits with code 0.

The current kinds are `browser-only` and `gateway`:

| Framework | Both kinds | Install path |
| --- | --- | --- |
| `langgraph-js` | Yes | local tarballs; 0.2.0 registry verification pending |
| `adk-js` | Yes | local tarballs; registry verification pending |
| `adk-go` | Both | local tarballs; registry verification pending |
| `langgraph-python` | Yes | local tarballs; registry verification pending |

ADK asks the same scripted quiz through a long-running `question.ask@1` capability,
then validates the answer and requests a text-only closing comment. Native
`requestInput` and custom `BaseAgent` subclasses remain refused. Browser-only
stores the pending question through the IndexedDB byte-record checkpoint port.
The generated README explains the selected project's mock and gateway behavior.
Run its `check` command to typecheck and assert the pinned emitted CSP and Trusted
Types baseline. The gateway check also compiles and probes its static handler, rejects production imports or compiled files that reach the dev/preview mock, and proves production completions return 503 without an upstream.

## Installation

The CLI detects npm, pnpm or yarn from `npm_config_user_agent`, defaults to npm,
and prints a fallback note for another manager in registry mode. It runs
`<manager> install --ignore-scripts` without a shell. Yarn 4 tarball mode uses
`yarn install --mode=skip-build` with the Yarn 4.18.1 Corepack pin.
`--no-install` skips this
step. On Windows automatic installation is skipped and the command is printed.
An install failure leaves the generated files and prints the manual command.
The CLI does not change registry or release-age configuration.

The standalone harness installs with scripts disabled. Windows automatic installation
remains unmeasured.
The package declares Node `>=22.22.2`; the measured patches are recorded in the
[standalone verification record](../../docs/standalone-verification.md).

Framework layers may declare `pnpm.allowBuilds`, a map of package names to boolean
build-script decisions. Composition merges matching decisions and rejects conflicts.
Only pnpm projects with build decisions or tarball overrides receive a sorted
`pnpm-workspace.yaml`. The ADK layer refuses
scripts for `@google/genai`, `cpu-features`, `protobufjs` and `ssh2`, including the
additional packages found by the plain-install probe. Automatic installs still use
`--ignore-scripts`.

`create --version` prints the package version and exits 0.

## Local tarballs

Set `GALAXIE_CREATE_PACKAGE_DIR` to an absolute, existing directory containing
exactly one `galaxie-ai-<name>-<version>.tgz` for each of the seven launch packages:
`ui-protocol`, `core`, `adapter-kit`, `adapter-langgraph`, `models`,
`storage-indexeddb` and `react`. Missing or duplicate matches fail before writing.
Every direct galaxie dependency and all seven overrides use absolute `file:`
specifications. Third-party pins stay unchanged. Tarball mode prints a one-line notice
and checks the name and version in each tarball's `package.json` against its file name
before writing; a mismatch fails with the field and expected value. The reader is a
consistency check, not a security boundary: it refuses archives with pax or GNU extended
headers, stops after 512 MiB of decompressed data and reads only `package/package.json`.

Tarball mode supports npm, pnpm 11 and Yarn 4. npm writes `overrides` to
`package.json`. pnpm writes `overrides` to `pnpm-workspace.yaml` alongside any
build decisions. Yarn writes `resolutions` to `package.json`, selects the
`node-modules` linker and declares the required peers that Yarn does not
auto-install. If the CLI detects Bun or an unknown manager, it exits before
writing, including with `--no-install`. Direct Node invocation defaults to npm.
Set `npm_config_user_agent=pnpm/11.21.0` or `npm_config_user_agent=yarn/4.18.1`
when invoking the built CLI directly to select that manager's files.

`@galaxie-ai/adapter-adk` is prepared for the same lockstep release. Until its release, ADK project
resolution requires tarball mode: set `GALAXIE_CREATE_PACKAGE_DIR` to a directory
containing one tarball for each of the seven launch packages and one for
`adapter-adk`. All eight overrides and the selected direct galaxie dependencies use
absolute `file:` specifications. LangGraph resolution still uses seven tarballs
and ignores an extra ADK adapter tarball. Registry-mode ADK installs are unsupported.

For `adk-go`, pack `adapter-go` and `starter-go` in addition to the seven launch
packages with Go 1.27.3 on PATH. All nine overrides point to those tarballs.
The generated [Go workflow](../../templates/frameworks/adk-go/files/GO.md) explains
the source hash, verified cache/prebuilt/local precedence, exact toolchain,
module layout and upgrade limits. A fresh project uses the prebuilt without Go;
editing needs Go 1.27.3. Its `dev` command builds and previews under the strict CSP,
with no HMR client. Both kinds support it; the standalone harness measurement is recorded in [docs/standalone-verification.md](../../docs/standalone-verification.md).

For `langgraph-python`, additionally pack `adapter-pyodide` and `starter-python`.
Prepare the wheel cache and run starter-python's complete prepack first, as its
[README](../starter-python/README.md) describes. All nine overrides use the
tarballs. The generated [Python workflow](../../templates/frameworks/langgraph-python/files/PYTHON.md)
explains raw source edits, wheel/runtime verification and license limits. Building
and previewing a generated project needs neither Python nor uv; its `dev` command
builds and previews without HMR. Registry installs remain unsupported. Both kinds
are covered by Chromium acceptance, and the standalone harness measurement is
recorded in the standalone verification record.

## Release evidence and limits

The repository pack test inspects all thirteen public packages with matching versions and exact packed internal dependencies. The packed-create test extracts the CLI into a temporary directory with only Node, runs `--help` and scaffolds with `--no-install`, comparing all output with checkout output. `create-clean` CI covers four frameworks in both kinds on Ubuntu Node 24, plus both LangGraph.js kinds on Node 22; standalone runs drive mock answers. See the [standalone verification record](../../docs/standalone-verification.md) for package-manager coverage. Registry installs of 0.2.0 await publication. Real models, devices and non-Linux CI remain unverified.

## Layers and writes

The composer combines `templates/base`, the selected `templates/kinds` layer and
the selected `templates/frameworks` layer. Files are verbatim; `_gitignore` emits
as `.gitignore`. JSON merges reject conflicting values. Only compiler type and
include arrays union. Output paths are sorted, use LF and have fixed file modes;
the project name is injected only into `package.json`.

Composition and target inspection finish before writes. Ordinary existing output
paths abort the run. Existing `AGENTS.md` and `CLAUDE.md` are preserved
case-insensitively when guidance emits those names.
Traversal, absolute output paths and symlink components are rejected. Writes use
exclusive creates and roll back only files and directories they created.
These checks do not isolate the target from concurrent processes with write access.
Generated manifests retain `license: Apache-2.0` and the starter SPDX headers.

## Coding-agent guidance

All eight kind/framework combinations add `AGENTS.md` with one versioned managed
block under 8192 bytes, `CLAUDE.md` containing exactly `@AGENTS.md` and a newline,
and matching real-file skill copies in `.agents/skills/galaxie` and
`.claude/skills/galaxie`. Each copy contains `SKILL.md`, all common references
(including host integration and the host-scoped Next.js reference), and only the
selected kind and framework references. Follow only references matching the
actual host and executor; these starters remain Vite apps. The block includes the baseline
do-and-never rules, supported shapes and verification commands. No existing
project source, CSP or Trusted Types output changes.

The single source is [skills/galaxie](../../skills/galaxie/README.md), loaded by the
CLI and rendered by [src/guidance.ts](src/guidance.ts), outside the template layers.
The composer accepts its optional file map through the usual collision and path
checks; compositions without guidance remain unchanged. The repository-only
composed test cache intentionally remains guidance-free. Eight `AGENTS.md` golden
files and source-byte comparisons cover rendering. Deliberately refresh goldens
with `pnpm exec vitest run --project node packages/create/test/guidance.node.test.ts --update`.
Citation hashes and unsupported-claim checks run in `pnpm run check:docs`.

Existing instruction files keep their bytes while new skill files are written.
When only one instruction file exists, the CLI prints an import hint; it does not
rewrite the existing file. Existing conflicting skill files abort ordinary create
writes. For an existing app, use the separate version-gated
[skill installer](../../skills/galaxie/README.md#install-into-an-existing-app).
No agent has been measured consuming the skill; the installer tag `v0.2.0`
does not exist until the maintainer creates it. Guidance adds files only; ADR-0012 guarantees are unchanged.

Repository-only tests and source mappings are composed under the ignored
`packages/create/.cache/composed` by `pnpm run compose:create`. Build the complete starter-go distribution before testing the Go composition:
`pnpm --filter @galaxie-ai/starter-go run prepack` with Go 1.27.3 on PATH.
The Go cache has a repository-only symlink to that package; its `go/` bytes match
project-mode output. Root compiler and
test commands regenerate it, and a conformance test rejects missing, changed or
unexpected cache output. Project-mode output omits those workspace artifacts.

Before testing Python compositions, run
`pnpm --filter @galaxie-ai/starter-python run prepack` and
`pnpm exec tsc -p packages/adapter-pyodide/tsconfig.build.json`. Their cache has
repository-only links to starter-python, adapter-pyodide and the pinned pyodide
npm package. Required wheels are independently bound to the installed adapter's
inventory during each build. The generated baseline binds the worker profile to
the presence of starter-go or starter-python; editing the profile cannot silently
widen another framework's headers.

Run `pnpm exec vitest run --project node packages/create/test` for focused tests
after composing the cache, and `pnpm check` for repository validation.
ADR-0031 stays Proposed; ADR-0012 guarantees are unchanged.

Example tarball workflow from the repository root (tarballs stay outside the checkout):

```sh
pnpm run build:packages
pnpm exec tsc -p packages/adapter-adk/tsconfig.build.json
mkdir -p /tmp/galaxie-tarballs
for starter_package in ui-protocol core adapter-kit adapter-langgraph models storage-indexeddb react adapter-adk; do
  pnpm --dir "packages/$starter_package" pack --pack-destination /tmp/galaxie-tarballs
done
# From the parent directory of the new app, use the built CLI:
GALAXIE_CREATE_PACKAGE_DIR=/tmp/galaxie-tarballs node /path/to/galaxie/packages/create/dist/cli.js my-adk-app browser-only adk-js
```

See the [verification record](../../docs/standalone-verification.md) for measured
versions, commands and limits. Nothing in this workflow publishes a package.

Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

To run the Python starter's standalone verification with npm:

```sh
node scripts/verify-standalone.ts --framework langgraph-python --mode tarball --tarballs <tarballs> --json /tmp/galaxie-python.json
```

Prepare the wheel cache before packing; generated builds and preview need no
Python or uv. See the [standalone record](../../docs/standalone-verification.md)
for measured versions and limits. `ormsgpack` stand-in licensing and checkpoint
compatibility are unconfirmed; certifi/orjson MPL-2.0 texts require maintainer
review before redistribution. Nothing publishes; ADR-0012 guarantees are unchanged.
