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

The current kinds are `browser-only` and `gateway`; both support `langgraph-js`.
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

The standalone harness measures npm installation with scripts disabled. Other
package-manager installs and Windows automatic installation remain unmeasured.
The package declares Node `>=22.22.2`; the measured patches are recorded in the
[standalone verification record](../../docs/standalone-verification.md).

## Local tarballs

Set `GALAXIE_CREATE_PACKAGE_DIR` to an absolute, existing directory containing
exactly one `galaxie-ai-<name>-<version>.tgz` for each of the seven launch packages:
`ui-protocol`, `core`, `adapter-kit`, `adapter-langgraph`, `models`,
`storage-indexeddb` and `react`. Missing or duplicate matches fail before writing.
Every direct galaxie dependency and all seven npm overrides use absolute `file:`
specifications. Third-party pins stay unchanged.

Tarball mode supports npm only and refuses pnpm and yarn before writing, including
with `--no-install`. Their real installs and the pnpm 11 override location are
deferred. The harness packs only the seven launch packages; this package remains
private and outside publication, launch and size-budget lists.

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
`packages/create/.cache/composed` by `pnpm run compose:create`. Root compiler and
test commands regenerate it, and a conformance test rejects missing, changed or
unexpected cache output. Project-mode output omits those workspace artifacts.

Run `pnpm exec vitest run --project node packages/create/test` for focused tests
after composing the cache, and `pnpm check` for repository validation.
ADR-0031 stays Proposed; ADR-0012 guarantees are unchanged.

Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).


Framework layers may declare `pnpm.allowBuilds`, a map of package names to boolean
build-script decisions. Composition merges matching decisions and rejects conflicts.
Only pnpm projects with decisions receive a sorted `pnpm-workspace.yaml`; other
managers and the LangGraph layer emit no additional file. The ADK layer refuses
scripts for `@google/genai`, `cpu-features`, `protobufjs` and `ssh2`, including the
additional packages found by the plain-install probe. Automatic installs still use
`--ignore-scripts`.
