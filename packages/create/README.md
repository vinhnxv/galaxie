# @galaxie-ai/create

Private, unpublished repository tooling for composing starter projects.
Layers remain in the repository; this package is not ready for registry installation.

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
| `langgraph-js` | Yes | Registry or npm tarballs |
| `adk-js` | Yes | npm tarballs; adapter private and unpublished |
| `adk-go` | Browser-only | npm tarballs; adapter and starter artifacts private and unpublished |

ADK asks the same scripted quiz through a long-running `question.ask@1` capability,
then validates the answer and requests a text-only closing comment. Native
`requestInput` and custom `BaseAgent` subclasses remain refused. Browser-only
stores the pending question through the IndexedDB byte-record checkpoint port.
The generated README explains the selected project's mock and gateway behavior.
Run its `check` command to typecheck and assert the pinned emitted CSP and Trusted
Types baseline. The gateway check also compiles and probes its static handler, rejects production imports or compiled files that reach the dev/preview mock, and proves production completions return 503 without an upstream.

## Installation

The CLI detects npm, pnpm or yarn from `npm_config_user_agent`, defaults to npm,
and prints a fallback note for another manager. It runs
`<manager> install --ignore-scripts` without a shell. `--no-install` skips this
step. On Windows automatic installation is skipped and the command is printed.
An install failure leaves the generated files and prints the manual command.
The CLI does not change registry or release-age configuration.

The standalone harness measures npm installation with scripts disabled. A plain pnpm 11 ADK install is also measured; the harness still uses npm.
Other manager installs and Windows automatic installation remain unmeasured.
The package declares Node `>=22.22.2`; the measured patches are recorded in the
[standalone verification record](../../docs/standalone-verification.md).

Framework layers may declare `pnpm.allowBuilds`, a map of package names to boolean
build-script decisions. Composition merges matching decisions and rejects conflicts.
Only pnpm projects with decisions receive a sorted `pnpm-workspace.yaml`; other
managers and the LangGraph layer emit no additional file. The ADK layer refuses
scripts for `@google/genai`, `cpu-features`, `protobufjs` and `ssh2`, including the
additional packages found by the plain-install probe. Automatic installs still use
`--ignore-scripts`.

## Local tarballs

Set `GALAXIE_CREATE_PACKAGE_DIR` to an absolute, existing directory containing
exactly one `galaxie-ai-<name>-<version>.tgz` for each of the seven launch packages:
`ui-protocol`, `core`, `adapter-kit`, `adapter-langgraph`, `models`,
`storage-indexeddb` and `react`. Missing or duplicate matches fail before writing.
Every direct galaxie dependency and all seven npm overrides use absolute `file:`
specifications. Third-party pins stay unchanged.

Tarball mode supports npm only and refuses pnpm and yarn before writing, including
with `--no-install`. Their real installs and the pnpm 11 override location are
deferred. For ADK the harness additionally builds and packs `adapter-adk`; this package remains
private and outside publication, launch and size-budget lists.

The private `@galaxie-ai/adapter-adk` is unpublished. Until its release, ADK project
resolution requires npm tarball mode: set `GALAXIE_CREATE_PACKAGE_DIR` to a directory
containing one tarball for each of the seven launch packages and one for
`adapter-adk`. All eight overrides and the selected direct galaxie dependencies use
absolute `file:` specifications. LangGraph resolution still uses seven tarballs
and ignores an extra ADK adapter tarball. Registry-mode ADK installs are unsupported.
Tarball mode continues to refuse pnpm and yarn before any project write.

For `adk-go`, pack `adapter-go` and `starter-go` in addition to the seven launch
packages with Go 1.27.3 on PATH. All nine npm overrides point to those tarballs.
The generated [Go workflow](../../templates/frameworks/adk-go/files/GO.md) explains
the source hash, verified cache/prebuilt/local precedence, exact toolchain,
module layout and upgrade limits. A fresh project uses the prebuilt without Go;
editing needs Go 1.27.3. Its `dev` command builds and previews under the strict CSP,
with no HMR client. Gateway support and real-network Go harness measurement are pending.

## Layers and writes

The composer combines `templates/base`, the selected `templates/kinds` layer and
the selected `templates/frameworks` layer. Files are verbatim; `_gitignore` emits
as `.gitignore`. JSON merges reject conflicting values. Only compiler type and
include arrays union. Output paths are sorted, use LF and have fixed file modes;
the project name is injected only into `package.json`.

Composition and target inspection finish before writes. Ordinary existing output
paths abort the run. Existing `AGENTS.md` and `CLAUDE.md` are preserved
case-insensitively if a layer emits those names; current layers emit neither.
Traversal, absolute output paths and symlink components are rejected. Writes use
exclusive creates and roll back only files and directories they created.
These checks do not isolate the target from concurrent processes with write access.
Generated manifests retain `license: Apache-2.0` and the starter SPDX headers.

Repository-only tests and source mappings are composed under the ignored
`packages/create/.cache/composed` by `pnpm run compose:create`. Build the complete starter-go distribution before testing the Go composition:
`pnpm --filter @galaxie-ai/starter-go run prepack` with Go 1.27.3 on PATH.
The Go cache has a repository-only symlink to that package; its `go/` bytes match
project-mode output. Root compiler and
test commands regenerate it, and a conformance test rejects missing, changed or
unexpected cache output. Project-mode output omits those workspace artifacts.

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
