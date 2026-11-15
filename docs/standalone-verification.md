# Standalone template verification

Measured on 2026-11-15 for `galaxie-wa5.1`. Results below describe the copied starters with no Built-in AI, WebGPU or upstream model.

## Characterization

Before any template fix, this command exited 1:

```sh
node scripts/verify-standalone.ts --node 22 --node 24 --mode both --json /tmp/galaxie-standalone-characterization.json
```

All eight installs, builds and preview drives passed. Eight advisory source checks and four gating hybrid server compiles failed. Every failure is listed below; classification was confirmed as template-owned. The missing compiler prevents discovery of any later type errors.

| ID | Template | Node | Mode | Phase | Confirmed source | Evidence | Resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BEFORE-1 | local-only | v22.23.5 | registry | typecheck (advisory) | template | `Error: Cannot find module '<temp>/local-only-22-registry/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-2 | local-only | v22.23.5 | tarball | typecheck (advisory) | template | `Error: Cannot find module '<temp>/local-only-22-tarball/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-3 | hybrid-gateway | v22.23.5 | registry | typecheck (advisory) | template | `Error: Cannot find module '<temp>/hybrid-gateway-22-registry/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-4 | hybrid-gateway | v22.23.5 | registry | compile | template | `Error: Cannot find module '<temp>/hybrid-gateway-22-registry/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-5 | hybrid-gateway | v22.23.5 | tarball | typecheck (advisory) | template | `Error: Cannot find module '<temp>/hybrid-gateway-22-tarball/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-6 | hybrid-gateway | v22.23.5 | tarball | compile | template | `Error: Cannot find module '<temp>/hybrid-gateway-22-tarball/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-7 | local-only | v24.15.0 | registry | typecheck (advisory) | template | `Error: Cannot find module '<temp>/local-only-24-registry/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-8 | local-only | v24.15.0 | tarball | typecheck (advisory) | template | `Error: Cannot find module '<temp>/local-only-24-tarball/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-9 | hybrid-gateway | v24.15.0 | registry | typecheck (advisory) | template | `Error: Cannot find module '<temp>/hybrid-gateway-24-registry/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-10 | hybrid-gateway | v24.15.0 | registry | compile | template | `Error: Cannot find module '<temp>/hybrid-gateway-24-registry/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-11 | hybrid-gateway | v24.15.0 | tarball | typecheck (advisory) | template | `Error: Cannot find module '<temp>/hybrid-gateway-24-tarball/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |
| BEFORE-12 | hybrid-gateway | v24.15.0 | tarball | compile | template | `Error: Cannot find module '<temp>/hybrid-gateway-24-tarball/node_modules/typescript/bin/tsc'` | Add pinned compiler and type tooling. |

The original driver also rejected the documented Trusted Types eval probe and the intentional gateway 503. Those were harness failures, resolved before the characterization rerun; the gateway and CSP were unchanged.

## Plan deviations

The delegated retry decision allows one additional diagnostic class: a Chromium resource-load 503 console error only during the deliberate hybrid unavailable step, correlated by its exact URL with a response event observed in that step at `/api/v1/chat/completions` with status 503. All other console errors, page errors, failed requests and HTTP errors fail. Offline Chromium controls cover a correlated pass, an uncorrelated diagnostic, another path, status 500, an error outside the step and a failed request. The Trusted Types probe is allowed at most once, with either exact Chromium wording of the documented probe.

The workspace build is the necessary exception to the plan's blanket temporary-write wording: `build:packages` writes ordinary ignored package outputs in the checkout before packing. Copied installs, tarballs, cache and npm configuration stay in the owned temporary root; requested JSON/log evidence stays outside the checkout. No user configuration is modified.

ADR-0031 stays Proposed. ADR-0012 guarantees are unchanged.

## Reproduce the measurement

From the repository root, use Node 24, the installed pnpm 11 workspace tooling,
npm 12 on PATH and repository Playwright Chromium. Install a target Node locally
with `nvm install 22` when absent; the harness never downloads Node. No Docker,
provider credential or upstream is needed.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node scripts/verify-standalone.ts --help
node scripts/verify-standalone.ts --node 22 --node 24 --mode both --json /tmp/galaxie-standalone-final.json
```

`--template local-only|hybrid-gateway|all` selects starters. `--node` is repeatable;
`--node 22=/absolute/path/to/node` overrides discovery. Otherwise the current
runtime wins for its major, then the newest matching nvm installation.
`--mode registry|tarball|both` selects installs. `--tarballs /path/to/dir` reuses
seven previously packed launch packages by copying them into the owned temporary
root. `--keep` retains that root and prints its path for investigation; remove it
afterward. `--min-release-age-exclude` is an explicit, recorded exception, not a
change to user configuration. No exclusion was used for this measurement.

Tarball mode first runs `build:packages` in the workspace, writing its ordinary
ignored build artifacts, then `pnpm pack` for the seven launch packages. It uses
the harness Node 24 and pnpm for packing, independently of the target Node. Every
copied project's install, build, preview and server compile/run uses the requested
Node binary. npm's resolved `npm-cli.js` is invoked by that binary explicitly;
Node 22's bundled npm is not used. All direct galaxie dependencies and all seven
transitive overrides point to the owned tarballs. The lockfile check requires one
file-resolved copy of each reachable galaxie package and rejects duplicates,
registry resolutions, missing required packages and unexpected galaxie packages.
Local-only reaches seven launch packages; hybrid reaches six (no storage package).

Copies live outside the repository and exclude `node_modules`, `dist`, `.server`,
`test` and `tsconfig.workspace.json`; symlinks are refused. Child environment names
are allowlisted, with empty owned npm user/global configuration and a fresh owned
cache. Upstream variables, authentication variables and `NODE_OPTIONS` do not pass
through. The public registry and seven-day release age are explicit; npm 12 and
its effective `min-release-age` are checked before installing. The harness never
publishes or edits user npm configuration. Cleanup stops child process groups and
removes the owned root on normal exit, failure and handled SIGINT/SIGTERM; SIGKILL
and machine crashes cannot run cleanup. All servers bind to `127.0.0.1`, with
bounded readiness polling; hybrid's compiled server requires port 4173 to be free.

The browser removes `LanguageModel` and `navigator.gpu`, aborts cross-origin
requests, and checks page errors, failed requests, HTTP errors and console errors
under the narrow exceptions above. Local-only selects radio `4`, submits and
expects `Correct. Keep practicing one small step at a time.` Hybrid starts the
gateway route, selects `4`, submits, requires the observed model HTTP 503 and
`The gateway is unavailable. Retry later.`, then checks Retry. Both hybrid servers
also receive a separate `POST /api/session` probe expecting HTTP 200; its response
body is cancelled without parsing, printing or recording it.

## Environment and final matrix

| Component | Measured version |
| --- | --- |
| Host | macOS arm64 |
| Harness Node | 24.15.0 |
| Target Nodes | 22.23.5 and 24.15.0 (local nvm installations) |
| npm for both targets | 12.2.2 |
| pnpm for workspace build/pack | 11.21.0 |
| Playwright | 1.64.1 |
| Chromium | 156.0.8078.4, headless, GPU/WebGPU disabled |
| Registry launch packages | 0.1.0, public npm registry |
| Harness commit | `0253a9f` (includes the reviewed cleanup and attribution fixes) |
| Workspace baseline | `29bdabf`, plus this PR's template changes |
| Release age | 10080 workspace minutes → 7 npm days; no exclusion |

After adding pinned TypeScript 7.0.2, Node types 24.19.2 and React/React DOM types
19.3.0 to both templates, all characterization rows pass. Hybrid also gains
`build:server`. No package source, manifest, export, peer range or dependency fix
was necessary. The lockfile changes only the two template importers.

| Template | Target Node | Registry | Packed workspace | Additional proof |
| --- | --- | --- | --- | --- |
| local-only | 22.23.5 | PASS | PASS | source check and mock answer |
| local-only | 24.15.0 | PASS | PASS | source check and mock answer |
| hybrid-gateway | 22.23.5 | PASS | PASS | source check, server compile, session probes, preview/server unavailable drives |
| hybrid-gateway | 24.15.0 | PASS | PASS | source check, server compile, session probes, preview/server unavailable drives |

Every case passes install, production Vite build and preview drive. Tarball cases
also pass the single-copy assertion. There are no remaining advisory errors or
release-gap findings in this matrix. JSON and raw local command logs were kept
outside the repository; temporary projects were removed.

The oldest **tested** major is 22, and it passes. Both manifests declare `engines.node` as
`>=22.22.2`, using npm 12's lower 22.x bound; the measured patch is 22.23.5, not
every admitted patch. npm 12.2.2 itself supports `^22.22.2 || ^24.15.0 || >=26`;
use one of those ranges when running this harness. `@langchain/openai@1.6.3`
requires Node 22 or later. Node 20 was not probed, and earlier 22.x patches,
odd-numbered majors and later majors were not measured. This is an installation
and wiring result, not a model-quality or device-performance measurement.

## Failure records and offline proof

The JSON output is an array of results: `template`, verified `node` (or the requested
major if version resolution fails), exact `npm` (or `unknown` before its probe),
`mode`, `releaseAgeDays`, `exclude`, `browser` and `failures`. Each failure contains
`phase`, `gating`, `source`, `suggested`, `summary` and `excerpt`; the parent result
supplies the template/node/mode identity. Phases are node, pack, copy, install,
build, typecheck, compile, serve, drive and probe. Only source type-check failures
are advisory. Suggested sources are template, `package:<name>`, environment,
harness or unclassified; triage must confirm them. Excerpts replace the temporary
root, HOME, URLs and credential-like fields and are capped at 16 lines/4000
characters. Any gating or unclassified failure causes exit 1; usage errors exit 2.
The human-readable matrix and JSON describe the same results. `--mode both`
compares failures as pass, defect, release-gap or workspace-regression.

`pnpm check` does not run the real network matrix. Its Node conformance lane runs
[the offline tests](../tests/conformance/verify-standalone.node.test.ts): pure
helper tables and rejection controls; release-age enforcement with a stub runner;
real npm `--offline` file-dependency installation, build and loopback subprocesses;
cleanup and abort; and real Chromium pages served by in-process loopback fixtures.
Expected package names, paths, statuses and UI text are fixed test oracles.
Additional real-process regressions cover an exited group leader, descendants with closed stdio, a SIGTERM-resistant process and SIGINT during a real Chromium drive. The 503 negative controls include a legitimate in-step 503 alongside the unrelated diagnostic, so missing-response rejection cannot mask correlation. A refused explicit Node binary retains the requested major for mode comparison. Template contract tests check the launch ranges and compiler/type dependency list.
No new test requires a prebuilt package `dist`.

The reusable script API is [standalone-core.ts](../scripts/standalone-core.ts):
`runStandalone` with injectable runner, driver, clock, ports, environment and roots,
and pure helpers for release age, environment, Node discovery, manifest rewrite,
lockfile copies, command/temp/copy checks, classification, redaction and mode
comparison. [verify-standalone.ts](../scripts/verify-standalone.ts) exports argument
parsing, template data, the lazy Chromium driver and result rendering. Importing
the core has no top-level I/O. No published package API or export was added;
core's main entry and its runtime Zod boundary are unchanged.

## Findings for later

- **FINDING-1 — Published-package Node engines.** The seven launch package
  manifests still lack the measured Node floor. Proposed fix: review and add their
  engines in the next coordinated release, with copied-consumer checks. This PR
  measures the starters and sets their engines only; no publication was performed.
- CI wiring should later import this core. The registry matrix remains a manual
  command; release verification should retain its JSON with each release.

## Unmeasured

Real Built-in AI, real WebGPU devices, WebLLM/model downloads, real upstream
inference, other package managers, bundled npm 10 versus npm 12, Windows, answer
quality, latency and memory are not covered. No live service, real user data,
backend authorization audit, broad packaging/API compatibility claim or ADR
acceptance is implied. ADR-0031 stays Proposed; ADR-0012 guarantees are unchanged.
