# Standalone project verification

The current harness scaffolds projects through the create CLI, prepared for the
0.2.0 release and not yet published. The earlier
2026-11-15 copied-starter characterization for `galaxie-wa5.1` is retained below.
Scaffolding also adds `AGENTS.md`, `CLAUDE.md` and real-file galaxie skill copies
in `.agents/skills/galaxie` and `.claude/skills/galaxie` for the selected kind and framework.
The current gateway preview drive answers through an in-process mock; the compiled
production server still follows the correlated 503 unavailable flow. These checks
use no Built-in AI, WebGPU or upstream model. Earlier records below predate the
gateway mock.

The Chromium drive allows zero Trusted Types probe errors for each framework
(`langgraph-js`, `adk-js`, `adk-go` and `langgraph-python`). Both JavaScript
starters configure Zod before creating the application's schemas. The Go and
Python framework layers configure Zod during bundling, and the starter browser
tests require zero policy violations and zero errors on their successful mock
drives.

## Release preparation (2026-11-17)

All thirteen public packages are prepared at 0.2.0; nothing is published by this
preparation and `v0.2.0` does not exist yet. The seven launch packages remain on
npm at 0.1.0. Historical registry measurements below used that older release and
do not verify 0.2.0 registry installs. The [release guide](releasing.md#publish-order)
lists all thirteen packages and the maintainer's publishing prerequisites.

The thirteen-package pack test checks matching versions, exact internal
workspace dependency rewrites, exports and distribution files. The isolated
packed-create test extracts create outside the checkout, runs help and a
`--no-install` scaffold with only Node on PATH, and compares every generated file
with checkout output. Local clean-PATH npm tarball runs cover browser-only
LangGraph.js and ADK Go with 0.2.0; generated checks, mock answers and CSP mutation
controls pass, including ADK Go's no-toolchain edited-source refusal. The
repository CI matrix below covers all eight combinations and the extra Node 22
LangGraph.js leg; its dated timings predate this version bump. New PR CI outcomes
must be checked separately before publishing.

The base tarball inventory remains the seven launch packages, with adapters and
starters added only for the selected framework; create itself is tested by the
separate packed-create test. All thirteen public package JavaScript projects now
compile through `build:packages`; artifact starter prepack remains separate.
Registry installs of 0.2.0 await publication. Real models, devices, pnpm/yarn
tarball mode and non-Linux CI remain unverified by this preparation. The whole
release waits for the recorded Python redistribution review, including the
Pyodide MPL-2.0 exception. Nothing is published; ADR-0012 guarantees are unchanged.

## Go starter hardening (2026-11-17)

The Go starter manifest now includes NOTICE length and SHA-256 metadata. Resolution
and release verification check it; Vite hashes the exact wasm, NOTICE and glue
buffers it consumes. For unchanged source, cache hits must match the packaged
wasm digest and length. Edited-source caches retain the documented trusted-writer
limit. Local replacements outside the hashed source tree are refused, except for
the manifest-checked bundled module. Its actual project replacement tree is
checked before lookup and after compilation, including package-directory overrides;
case aliases of ignored directories are refused. The native-vet test probes a failed download's
failed HTTP endpoint and skips locally only when Go reports a transport failure
and the independent probe also fails, or downloads are explicitly disabled; HTTP errors and CI failures remain failures.

Twenty scratch-copy mutations remove individual verification, replacement and
offline-skip guards or reintroduce a second read. Each fails the relevant tests.
The built wasm (29,897,761 bytes), glue (16,992 bytes) and NOTICE (229,611 bytes)
retain their previous SHA-256 digests:

| Artifact | SHA-256 before and after |
| --- | --- |
| `agent.wasm` | `bff0abbb35389b1fbc3e2757f98574abcebfd758b843852da96cf1f5731c2c30` |
| `wasm_exec.js` | `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14` |
| `NOTICE.txt` | `0e6ac7e18566aecd5f96378a6e0997a58411bf3c1de11397181207c8dfd7844f` |

Both kinds pass the npm tarball harness on macOS, Node 24.15.0, npm 12.2.2 and
Chromium 156.0.8078.4, with Go, Python and uv absent from generated-project PATH.
Browser-only reaches the scripted answer in 10,399 ms and gateway in 5,498 ms;
generated checks, CSP mutation rejections and the gateway compiled-server probes
pass. Rebuilding those installed projects with the previous framework configuration
produces identical paths and bytes for all 14 browser-only and six gateway output
files. Only the six ADK Go scaffold hash rows change because `vite.framework.ts`
now verifies the consumed buffers; other scaffold pins remain unchanged. Composed
workspace caches match the current layers for all eight combinations.

These are local scripted measurements. No live stack, real model, device or new
Firefox/WebKit measurement was run. Nothing is published; the package stays at
0.2.0 and ADR-0012 guarantees are unchanged.

## Clean-environment CI

The `create-clean` job in `.github/workflows/ci.yml` runs the existing harness
with npm 12.2.2, locally packed tarballs, `--kind all`, `--clean-path` and
`--budget-minutes 10` on Ubuntu 24.04. Four Node 24 legs cover `langgraph-js`,
`adk-js`, `adk-go` and `langgraph-python`: all eight kind/framework combinations.
A fifth leg repeats both LangGraph JavaScript kinds on Node 22. Preparation and
packing use the full PATH, including Go or the prepared Python wheel cache where
needed; generated projects are outside the checkout and use the requested Node.
Nothing is published.

Every generated-project process, including scaffold, install, build, check,
negative controls, server compilation, preview and gateway servers, receives a
PATH containing only an owned scratch directory with symlinks to `node` and `sh`.
npm's resolved CLI is invoked explicitly through the requested Node binary.
Before scaffolding, the harness checks that `go`, `python`, `python3` and `uv`
cannot be found, then probes each through a child Node process and requires
`ENOENT`. The Chromium driver runs in the harness process, outside this PATH
restriction. `sh` is required by npm's script runner; no inherited system-tool
directory is admitted.

Each result records `durationMs` from the start of scaffold to the preview mock
answer, including install, build, generated checks and CSP mutation controls.
If that path fails before the answer, the duration ends at the failure point.
Packing, cleanup and the gateway's later compiled-server 503 drive are outside
that interval. The ADK Go edited-source control described below is also excluded.
The default budget is 10 minutes per project; `--budget-minutes` accepts integers
from 1 to 60. An overrun adds a gating `budget` failure with the summary
`budget exceeded: <measured> ms of <allowed> ms`. The elapsed-time gate is
evaluated after the project run. Each CI leg also has a 45-minute job timeout.
JSON results are printed to the job log and
per-project durations are written to the job summary.

The scope output skips this job only for a non-empty documents-only change list
(Markdown, paths under `docs/`, or `llms.txt`); other changes and unknown/empty
lists run it. The final `ci` gate depends on `create-clean`. Acceptance of the
first PR run requires all five legs to conclude `success`, not `skipped`.

Local measurements on macOS (2026-11-17), with the clean PATH asserted, reached the
mock answer within the budget:

| Kind / framework | Scaffold to mock answer | Result |
| --- | --- | --- |
| browser-only / langgraph-js | 13,277 ms | PASS |
| browser-only / adk-go | 13,108 ms | PASS |

Linux CI (ubuntu-24.04, first run on PR #277, tarball mode, clean PATH asserted, 10-minute budget)
reached the mock answer for every project. Scaffold to mock answer, from the job logs:

| Framework | Node | browser-only | gateway |
| --- | --- | ---: | ---: |
| langgraph-js | 24.22.2 | 17,034 ms | 12,268 ms |
| langgraph-js | 22.23.4 | 17,780 ms | 12,142 ms |
| adk-js | 24.22.2 | 19,782 ms | 10,266 ms |
| adk-go | 24.22.2 | 14,960 ms | 8,336 ms |
| langgraph-python | 24.22.2 | 17,456 ms | 14,817 ms |

These are one cold run each on GitHub-hosted runners. They exclude packing and starter
artifact preparation, and for the gateway kind they stop at the preview mock answer,
before the compiled server leg. They are a single observation, not a distribution.

Unmeasured by this clean-environment matrix: pnpm and yarn installs, registry
mode and the scheduled registry run, Windows, macOS CI, Node versions other than
22 and 24, and real model providers. Tarball mode refuses pnpm and yarn before
any write; registry CI and its schedule are deferred until 0.2.0 is published
for this workflow. Earlier manual registry records below are separate
evidence. The other limits in [Unmeasured](#unmeasured) still apply.

With `--framework adk-go --mode tarball --clean-path`, the harness also checks
the no-Go edited-source refusal. After the normal build, it appends a comment to
`go/agent.go`, runs the same build and requires a failure containing
`The agent source in go/ was edited and Go 1.27.3 was not found on PATH`.
It restores the original bytes in `finally` and requires the restored build to
pass. The edit and both extra builds are excluded from the per-project
`durationMs` and time budget. This control runs only for ADK Go with `--clean-path`;
the generated project's behavior and ADR-0012 guarantees are unchanged.

## LangGraph Python measurement (2026-11-16)

Both kinds compose `langgraph-python` with private `adapter-pyodide` and
`starter-python` packages. Prepack selects the adapter's LangGraph wheel lane and
the two local wheels from a prepared cache, verifies their bytes and SHA-256, and
retains wheel metadata and license texts. Generated builds verify those artifacts
against the installed adapter, copy the pinned npm Pyodide runtime and emit the
project's raw Python sources. Neither package is published.

`starter-python-browser.node.test.ts` answers from the mock with an empty PATH,
reflects an edit to `graph.py` after rebuilding, names missing/corrupt wheels on
build failure, and exercises the wasm CSP refusal. The composed reload test keeps
the pending question and saved session. `starter-python-gateway.node.test.ts`
answers through preview with the agent's system prompt set and Python/uv absent
from PATH. Its captured browser request contains only a user message and keeps
`metadata.promptId`; production still returns 503 without an upstream. Page and
Worker responses retain the pinned CSP, with no external requests, page errors
or CSP/Trusted Types violations on the acceptance happy paths.

After preparing nine npm tarballs, this real-network run exits 0 with a PATH
containing only Node, npm and `sh` (no `python`, `python3` or `uv`):

```sh
node scripts/verify-standalone.ts --framework langgraph-python --mode tarball --tarballs <tarballs> --json <result-file>
```

| Kind / framework | Target Node | npm | Mode | Chromium | Result |
| --- | --- | --- | --- | --- | --- |
| browser-only / langgraph-python | 24.15.0 | 12.2.2 | Tarball | 156.0.8078.4 | PASS |
| gateway / langgraph-python | 24.15.0 | 12.2.2 | Tarball | 156.0.8078.4 | PASS |

Both results have empty failure arrays. Installation, file-resolved single-copy
checks, production builds, generated checks, both directive mutation controls and
mock browser drives pass with the seven-day release age, no exclusion and no
lifecycle-script fallback. Gateway also passes its compiled production-server
503 drive and session probes. Temporary projects are removed; JSON and logs stay
outside the checkout. An earlier restricted-PATH attempt failed before browser
drives with `npm error enoent spawn sh ENOENT`; retaining `sh` resolves that
environment failure without adding Python or uv.

The gateway static server adds only `.mjs` JavaScript and `.wasm` WebAssembly MIME
types required by browser modules and streaming WebAssembly compilation.
All 18 existing kind/framework/package-manager outputs retain main's bytes after
subtracting exactly these two lines and the shared baseline dependency binding.
Their CSP sources and emitted headers are unchanged.

The combined local Vitest suite caps workers at four to bound simultaneous
Chromium/Pyodide startup. Earlier full runs had RAG browser interception failures
that passed alone; the cap bounds contention, without establishing that it was
the sole cause. Named Python shards now partition the Node inventory, including
both Python composed projects, without admitting browser-project files into Node.

The final `pnpm check`, with Go 1.27.3 first on PATH, exits 0: 568 Vitest files
and 8,343 tests pass, with two expected failures and 165 skips; Python has 1,968
passes and one skip. Go tests, Pyright, both TypeScript versions, builds,
dependency/docs checks and all size budgets pass. The earlier RAG browser cases
pass in this combined run; the interception timeout's original cause remains
unproven.

**Maintainer review before redistribution:** `ormsgpack` is a limited same-name
stand-in, not upstream. Its NOTICE says **license to be confirmed by the
maintainer**; checkpoint serializer compatibility is unverified, and replacing it
may make saved checkpoints unreadable. `certifi` and `orjson` ship MPL-2.0 texts
that also need maintainer review. Nothing publishes. Firefox/WebKit, real models,
pnpm/yarn end to end, Node 22, CI cold start, Pyodide startup time, local-wheel
reproducibility and adapter-bridge version binding remain unmeasured.
ADR-0012 guarantees are unchanged.

## ADK Go measurement (2026-11-16)

The private, unpublished `@galaxie-ai/starter-go` package supplies the browser-only
ADK Go starter's prebuilt agent, verified glue, Go module source, manifest and
notices. With Go 1.27.3 on PATH, its prepack produced 29,897,761 wasm bytes with
SHA-256 `bff0abbb35389b1fbc3e2757f98574abcebfd758b843852da96cf1f5731c2c30`.
Artifact conformance compares four clean/git/symlink-shaped builds, pack/plugin
source identities, glue tampering and a broken module replacement.

`tests/conformance/starter-go-browser.node.test.ts` passes all four Chromium
cases: unedited prebuilt without Go; edited-source refusal with the exact documented
message and no output; an edited local build followed by a no-Go cache hit; and an
unedited version-only artifact upgrade without Go. Each successful browser drive
answers the quiz from the mock and checks the logged origin and wasm digest,
same-origin requests, zero CSP/Trusted Types violations and zero errors. The
negative control without `wasm-unsafe-eval` cannot open the question or compile
an empty wasm module. The Go overlay initializes Zod in jitless mode before page
dependencies create schemas, preventing its caught eval probe without changing
any CSP directive.

The seven launch packages plus `adapter-go` and `starter-go` were packed locally
with Go 1.27.3. Then, with a PATH containing Node and system tools but no Go,
this real-network command exited 0:

```sh
node scripts/verify-standalone.ts --framework adk-go --mode tarball --tarballs <tarballs> --json /tmp/galaxie-adk-go-network-final.json
```

| Kind / framework | Target Node | npm | Mode | Chromium | Result |
| --- | --- | --- | --- | --- | --- |
| browser-only / adk-go | 24.15.0 | 12.2.2 | Tarball | 156.0.8078.4 | PASS |
| gateway / adk-go | 24.15.0 | 12.2.2 | Tarball | 156.0.8078.4 | PASS |

Each result has an empty failure array. Installation, single-copy checks,
production build, generated checks, directive mutation controls and the mock
browser drive pass with a seven-day release age, no exclusion and no lifecycle
script fallback. The harness removed its temporary projects; JSON and logs stay
outside the checkout. Gateway also passes its compiled production-server 503
flow and session probes. Nothing was published.

The first additional gateway run exited 1 after install/build/check passed:

```text
negative-control [harness]: negative-control failed.
Negative control could not mutate script-src.
```

The harness's direct-array mutation did not match the framework-aware conditional
in the gateway CSP source. Its mutation now inserts the forbidden directive in
both branches; offline controls exercise each branch, still require the exact
rejection and verify restoration. The rerun and the final two-kind run exit 0.
No header or server assertion was loosened.

Firefox/WebKit for the Go starter, real models, pnpm/yarn installs end to end,
a cold Go module cache, Node 22 and CI cold-start time remain unmeasured. The
pnpm symlink shape has build-level evidence only. Local `go.mod` replacement
targets are now rejected outside the hashed `go/` tree, except for the bundled
starter-go module checked against its manifest digest. Edited-source cache
sidecars provide consistency checks only; their directory must remain under
trusted writers' control, as described in the [package limits](../packages/starter-go/README.md#limits).
A release changing the template Go tree requires Go for older projects.
ADR-0012 guarantees are unchanged.

## ADK overlay measurement (2026-11-16)

Both starter kinds now support `--framework adk-js --mode tarball`. The adapter
remains private and unpublished, so ADK registry mode and `--mode both` are
refused. The default framework remains LangGraph; its seven launch packages and
existing drive expectations are unchanged. ADK explicitly builds and packs one
additional adapter. Each ADK lockfile must contain one file-resolved copy of every
reachable galaxie package, with no unrecognized adapter allowed.

The ADK question is scripted before model inference through an ordinary-name
long-running capability. After a validated answer, its callback sends a text-only
closing prompt, matching the existing gateway and local providers. The quiz grade
stays in the tool response; the displayed closing reply has no grade prefix.
Node and Chromium workspace tests cover pause/resume and custom-agent refusal;
the built browser-only test reloads the same pending question and session key from
IndexedDB with no model downloads under the unchanged CSP and Trusted Types.

The public adapter root also loads ADK. To enable jitless Zod before that load,
the overlay initializes Zod, dynamically loads the adapter and calls its environment
shim, then loads the agent. The framework Vite config explicitly disables ADK span
content capture. No CSP or Trusted Types allowance was added.

After the final `pnpm check` passed, each real-network command ran once and exited 0:

```sh
node scripts/verify-standalone.ts --framework adk-js --kind all --node 22 --node 24 --mode tarball --json /tmp/galaxie-adk-network-final.json
node scripts/verify-standalone.ts --kind all --node 22 --node 24 --mode both --json /tmp/galaxie-langgraph-network-final.json
```

| Kind / framework | Target Node | npm | Registry | Packed workspace |
| --- | --- | --- | --- | --- |
| browser-only / adk-js | 22.23.5 | 12.2.2 | Unsupported | PASS |
| gateway / adk-js | 22.23.5 | 12.2.2 | Unsupported | PASS |
| browser-only / adk-js | 24.15.0 | 12.2.2 | Unsupported | PASS |
| gateway / adk-js | 24.15.0 | 12.2.2 | Unsupported | PASS |
| browser-only / langgraph-js | 22.23.5 | 12.2.2 | PASS | PASS |
| gateway / langgraph-js | 22.23.5 | 12.2.2 | PASS | PASS |
| browser-only / langgraph-js | 24.15.0 | 12.2.2 | PASS | PASS |
| gateway / langgraph-js | 24.15.0 | 12.2.2 | PASS | PASS |

All 12 results have empty failure arrays. Each passes installation, production
build, generated checks, directive mutation controls and the preview browser drive;
tarball cases pass single-copy checks. Gateway cases also compile and drive the
production server's 503 path and probe sessions. The host was macOS arm64 with
harness Node 24.15.0, pnpm 11.21.0, Playwright 1.64.1 and Chromium 156.0.8078.4.
Release age remained seven days with no exclusions or lifecycle-script fallback.
JSON and logs stay outside the checkout; the harness removed its temporary projects.

A fresh plain install with pnpm 11.21.0 and closed stdin first exited 1:

```text
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @google/genai@1.52.0, @google/genai@2.32.0, cpu-features@0.0.10, protobufjs@7.6.6, ssh2@1.17.0
```

Explicit `false` decisions for `@google/genai`, `cpu-features`, `protobufjs` and
`ssh2` let the plain install exit 0. The pnpm 11 offline acceptance test packs a
local `protobufjs` fixture whose script writes a sentinel, runs with closed stdin,
and requires failure without the generated policy, success with it, and no
sentinel in either case. This check is offline and part of `pnpm check`; the
real-network install and harness matrices remain manual.

The end-of-unit repeat used a fresh generated browser-only ADK pnpm project with
only its adapter dependency changed to the local `adapter-adk` tarball. A plain
`corepack pnpm install` on Node 24.15.0, pnpm 11.21.0, with closed stdin and no
`--ignore-scripts`, exited 0 in 4.1 seconds. It reported deprecation and peer
dependency warnings, with no ignored-build error or dependency script execution.
The owned probe project was removed after recording the result.

ADK real-model closing replies (Built-in AI, WebLLM and a real upstream), ADK
registry installs, full-tree LangGraph pnpm installs, yarn and bun, Windows,
pnpm harness runs and ADK browsers beyond Chromium remain unmeasured.
ADR-0012 guarantees are unchanged.

## Gateway mock measurement (2026-11-16)

The gateway-only matrix ran three times with the same command:

```sh
node scripts/verify-standalone.ts --kind gateway --node 22 --node 24 --mode both --json /tmp/galaxie-wa5-4-network.json
```

1. The first run, before the transport correction below, exited 1: all four rows
   (Node 22.23.5 and 24.15.0, registry and packed workspace, npm 12.2.2) passed
   installation, build, generated checks and directive mutation controls, and each
   recorded one gating drive failure with the exact excerpt `Request failed.`
2. After the correction, the matrix was rerun on the corrected tree and exited 0.
3. After the review follow-ups to the gateway server and its tests, the matrix was
   rerun on the final code and exited 0.

| Target Node | npm | Registry | Packed workspace |
| --- | --- | --- | --- |
| 22.23.5 | 12.2.2 | PASS | PASS |
| 24.15.0 | 12.2.2 | PASS | PASS |

Each passing row covers installation, the production Vite build, the generated
checks and mutation controls, the preview drive through the mock and the
compiled-server 503 drive, with the release-age policy at 7 days and no
exclusion or lifecycle-script fallback. JSON and command logs remain outside the
repository; temporary projects were removed.

A loopback reproduction of the first failure showed that the page received the mock
result and status, then Chromium reported `net::ERR_ABORTED` as the SDK cancelled
its SSE reader. The host wrapper now drains a clone of successful mock responses
before giving the original response to the SDK. Real-upstream responses keep their
existing path, and the harness driver stays strict. Real-provider behavior remains
unmeasured.

## Earlier composed-project measurement (2026-11-16, before the gateway mock)

The adapted harness ran once with a 25-minute wall-clock cap and exited 0:

```sh
node scripts/verify-standalone.ts --mode both --node 22 --node 24 --json /tmp/galaxie-create-u5-network.json
```

| Combination | Target Node | npm | Registry | Packed workspace |
| --- | --- | --- | --- | --- |
| browser-only / langgraph-js | 22.23.5 | 12.2.2 | PASS | PASS |
| browser-only / langgraph-js | 24.15.0 | 12.2.2 | PASS | PASS |
| gateway / langgraph-js | 22.23.5 | 12.2.2 | PASS | PASS |
| gateway / langgraph-js | 24.15.0 | 12.2.2 | PASS | PASS |

All eight results have empty failure arrays. Each passes CLI scaffolding,
installation with lifecycle scripts disabled, production build, `npm run check`,
both directive mutation controls and the preview browser drive. Tarball results
also pass single-copy checks. Each gateway case additionally compiles and drives
the static Node server and probes sessions on both servers. No lifecycle-script
fallback or release-age exclusion was needed.

The host was macOS arm64, using harness Node 24.15.0, pnpm 11.21.0 for workspace
build/pack, Playwright 1.64.1 and headless Chromium 156.0.8078.4. Registry packages
were the seven launch packages at 0.1.0; packed packages came from the current
checkout. The workspace policy remained 10080 minutes, enforced as seven npm days.
The measured tree includes the create commits through `93f4281` and the harness
adaptation in this change. JSON and the command log remain outside the repository;
the harness removed its temporary projects.

## Previous copied-starter characterization

Before the earlier template fixes, this command exited 1:

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

The delegated retry decision allows one additional diagnostic class: a Chromium resource-load 503 console error only during the deliberate hybrid unavailable step, correlated by its exact URL with a response event observed in that step at `/api/v1/chat/completions` with status 503. Offline Chromium controls cover a correlated pass, an uncorrelated diagnostic, another path, status 500, an error outside the step and a failed request. The characterization allowed one Trusted Types probe with either exact Chromium wording. The current driver fails on the first such error for every framework.

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
pnpm exec tsc -p packages/create/tsconfig.build.json
node scripts/verify-standalone.ts --help
node scripts/verify-standalone.ts --node 22 --node 24 --mode tarball --json /tmp/galaxie-standalone-final.json
```

`--kind browser-only|gateway|all` selects kinds. `--framework langgraph-js|adk-js|adk-go|langgraph-python`
selects the framework (default `langgraph-js`); ADK and LangGraph Python require `--mode tarball`.
ADK Go and LangGraph Python support both kinds.
The old `--template` flag is rejected. `--node` is repeatable;
`--node 22=/absolute/path/to/node` overrides discovery. Otherwise the current
runtime wins for its major, then the newest matching nvm installation.
`--mode registry|tarball|both` selects installs. Use tarball mode until 0.2.0 is published; current registry runs cannot resolve the new ranges. `--tarballs /path/to/dir` reuses
seven previously packed launch packages (plus `adapter-adk` for ADK JavaScript, or `adapter-go` and `starter-go` for ADK Go, or `adapter-pyodide` and `starter-python` for LangGraph Python) by copying them into the owned temporary
root. `--keep` retains that root and prints its path for investigation; remove it
afterward. `--min-release-age-exclude` is an explicit, recorded exception, not a
change to user configuration. No exclusion was used for this measurement.

Tarball mode first runs `build:packages` in the workspace, writing its ordinary
ignored build artifacts, then `pnpm pack` for the seven launch packages. ADK runs additionally compile and
pack `adapter-adk` for JavaScript, or `adapter-go` and `starter-go` for Go,
without adding them to the launch inventory. Python additionally compiles `adapter-pyodide`
and packs it with `starter-python`. Prepare `.cache/python-wheels` with the repository
fetch/build scripts before packing; prepack only verifies cached wheels and never
downloads or invokes Python. Generated Python builds and previews need no Python
or uv. Go packing requires Go 1.27.3
on PATH and invokes starter-go prepack to produce its complete dist. It uses
the harness Node 24 and pnpm for packing, independently of the target Node. Every
generated project's scaffold, install, build, check, preview and server compile/run uses the requested
Node binary. npm's resolved `npm-cli.js` is invoked by that binary explicitly;
Node 22's bundled npm is not used. All direct galaxie dependencies and all seven
transitive overrides point to the owned tarballs. The lockfile check requires one
file-resolved copy of each reachable galaxie package and rejects duplicates,
registry resolutions, missing required packages and unexpected galaxie packages.
Browser-only reaches seven launch packages; gateway reaches six (no storage package).

The scaffold hook runs the built CLI with a relative target, selected kind/framework
and `--no-install`. In tarball mode it receives the owned tarball directory through
`GALAXIE_CREATE_PACKAGE_DIR`; registry mode receives no tarball setting. Projects
live outside the repository. `assertCopy` rejects workspace artifacts such as
`node_modules`, `dist`, `.server`, `test`, `tsconfig.workspace.json`, `.npmrc`,
`.git` and environment files before installation, and refuses symlinks.
Child environment names
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
expects `Correct. Keep practicing one small step at a time.` Gateway preview starts the
gateway route, selects `4`, submits and requires both
`Correct. This is a fixed reply from the mock upstream.` and
`Replies are fixed sample text from a mock upstream.` The compiled server follows
the same question flow but requires the observed model HTTP 503 and
`The gateway is unavailable. Retry later.`, then checks Retry. Both gateway servers
also receive a separate `POST /api/session` probe expecting HTTP 200; its response
body is cancelled without parsing, printing or recording it.

Every generated project must pass `npm run check` after the build. This includes
client/check TypeScript compilation, exact Vite CSP and Trusted Types assertions,
and the gateway's compiled static-handler header, transitive production import
boundary, absence of compiled dev/mock files and imports, and authenticated
production 503 without an upstream. The harness then separately adds
`'unsafe-inline'` to `script-src` and empties `require-trusted-types-for`, reruns the
check, and requires a rejection naming the changed directive. A check that passes
or fails for an unrelated reason makes the negative-control phase fail. The CSP
source is restored in `finally` after each mutation. Installs use
`npm install --ignore-scripts --no-audit --no-fund`; no fallback to lifecycle
scripts was needed in the measured matrix.

Tarball mode supports npm only. pnpm and yarn are refused by the create CLI until
follow-up work proves their installs and override locations. The create
package is outside this harness's seven-package base inventory; its isolated
packed-create conformance test verifies its tarball separately. This harness
never publishes packages or creates tags.

## Previous copied-starter environment and final matrix

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

In that measurement, after adding pinned TypeScript 7.0.2, Node types 24.19.2 and React/React DOM types
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
`mode`, `releaseAgeDays`, `exclude`, `browser`, `durationMs` and `failures`. Each failure contains
`phase`, `gating`, `source`, `suggested`, `summary` and `excerpt`; the parent result
supplies the combination/node/mode identity. Current phases are node, pack,
scaffold, install, build, check, negative-control, compile, serve, drive, probe and budget.
All current failures are gating; the earlier advisory source check has been
replaced by `npm run check`. Suggested sources are template, `package:<name>`, environment,
harness or unclassified; triage must confirm them. Excerpts replace the temporary
root, HOME, URLs and credential-like fields and are capped at 16 lines/4000
characters. Any gating or unclassified failure causes exit 1; usage errors exit 2.
The human-readable matrix and JSON describe the same results. `--mode both`
compares failures as pass, defect, release-gap or workspace-regression.

Chromium reports failed requests with the navigation or numbered drive action
that started them, the HTTP status or browser error code and request elapsed
time. The excerpt shows known scaffold paths, masks unknown path segments and
omits URL origins, queries and fragments. The harness requires a successful
HTTP readiness response before opening Chromium. Each drive makes one initial
navigation attempt.

`pnpm check` does not run the real network matrix. Its Node conformance lane runs
[the offline tests](../tests/conformance/verify-standalone.node.test.ts): pure
helper tables and rejection controls; scaffold-hook arguments and artifact rejection;
gating checks and negative-control/restoration cases; release-age enforcement with a stub runner;
real npm `--offline` file-dependency installation, build and loopback subprocesses;
cleanup and abort; and real Chromium pages served by in-process loopback fixtures.
Expected package names, paths, statuses and UI text are fixed test oracles.
Additional real-process regressions cover an exited group leader, descendants with closed stdio, a SIGTERM-resistant process and SIGINT during a real Chromium drive. The 503 negative controls include a legitimate in-step 503 alongside the unrelated diagnostic, so missing-response rejection cannot mask correlation. A refused explicit Node binary retains the requested major for mode comparison. Template contract tests check the launch ranges and compiler/type dependency list.
No new test requires a prebuilt package `dist`.

The reusable script API is [standalone-core.ts](../scripts/standalone-core.ts):
`runStandalone` with a required scaffold hook and injectable runner, driver, clock,
ports, environment and roots, plus helpers for release age, environment, Node
discovery, lockfile copies, command/temp/scaffold checks, classification, redaction and mode
comparison. [verify-standalone.ts](../scripts/verify-standalone.ts) exports argument
parsing, combination data, the lazy Chromium driver and result rendering. Importing
the core has no top-level I/O. No published package API or export was added;
core's main entry and its runtime Zod boundary are unchanged.

## Findings for later

- **FINDING-1 — Published-package Node engines, addressed in 0.2.0 preparation.**
  All thirteen public manifests now declare Node `>=22.22.2`, including the original
  seven. This is a consistent declaration; the standalone evidence covers only
  the recorded Node 22/24 patches, not every version admitted by that range.
- The clean-environment CI job uses this core for tarball installs. The registry
  matrix remains a manual command; release verification should retain its JSON
  with each release.

## Unmeasured

Real Built-in AI, real WebGPU devices, WebLLM/model downloads, real upstream
inference, pnpm/yarn harness installs, the pnpm 11 override location, bundled npm 10 versus
npm 12, Windows automatic install and operation, answer
quality, latency and memory are not covered. No live service, real user data,
backend authorization audit, broad packaging/API compatibility claim or ADR
acceptance is implied. ADR-0031 stays Proposed; ADR-0012 guarantees are unchanged.
