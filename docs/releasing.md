# Releasing galaxie

The next lockstep release is 0.2.0 across thirteen packages. This branch prepares
it; nothing is published and no tag or release is created by the preparation.
Publishing, tagging and release notes are manual maintainer steps.
`eslint-plugin` and `tools-mcp` remain private. The registry currently has 0.1.0
of the seven launch packages and none of the six promoted packages. Registry
installs of 0.2.0 remain unverified until the maintainer publishes it.

## Versioning

Versions are `0.MINOR.PATCH`. While the major version is 0, a breaking public API
change may land in a minor release and must be called out in the release notes.
A patch release does not break a public API. All thirteen packages in the publish
order below share one version and are released together. pnpm rewrites their
internal `workspace:*` dependencies to that exact version when packing.
Generated projects retain caret ranges such as `^0.2.0`; upgrade all
`@galaxie-ai/*` ranges together for a lockstep bump.

Update all thirteen package manifests, plus:

- `packages/core/src/version.ts` and the advertised adapter versions in
  `packages/adapter-{langgraph,pyodide,adk,go}/src/adapter.ts`.
- The exported versions in `packages/starter-go/src/index.ts` and
  `packages/starter-python/src/index.ts`.
- `skills/galaxie/SKILL.md` frontmatter, equal to core's version, and its README example.
- The galaxie ranges in `templates/**/layer.json` and any current generated-project
  documentation that names them. Regenerate and review create guidance goldens;
  version and pin conformance tests derive their expectations from manifests.
- Current release documentation and upgrade notes. Preserve dated historical
  measurements, agent-definition versions, protocol pins and Go module versions.

`ui-protocol` has no hand-written package-version constant; its specification pins
are independent of its package version. Starter artifacts embed their package
version: run each starter's `prepack` after a bump, before tests read its `dist`.
Use Go 1.27.3 on PATH for the Go starter and the prepared wheel cache for Python.
Commit the coordinated bump with `git commit -s`.

## Publish order

Dependencies must precede their consumers, as derived from public package
manifests. The additional release policy is explicit: **starters and adapters
before create, create last**, because generated framework layers select these
packages without create having runtime dependencies on them. The conformance
test checks the complete public inventory, dependency edges and this policy.

1. `@galaxie-ai/ui-protocol`
2. `@galaxie-ai/core`
3. `@galaxie-ai/adapter-kit`
4. `@galaxie-ai/adapter-langgraph`
5. `@galaxie-ai/models`
6. `@galaxie-ai/storage-indexeddb`
7. `@galaxie-ai/react`
8. `@galaxie-ai/adapter-pyodide`
9. `@galaxie-ai/adapter-adk`
10. `@galaxie-ai/adapter-go`
11. `@galaxie-ai/starter-go`
12. `@galaxie-ai/starter-python`
13. `@galaxie-ai/create`

## Create packaging

The create tarball ships `dist`, `templates`, `skills`, `LICENSE` and `NOTICE`,
plus npm's included README and manifest. Prepack copies repository templates and
the galaxie skill into ignored package directories; postpack removes the copies.
`pnpm --filter @galaxie-ai/create run clean:pack` also removes them after an
interrupted pack. The CLI tries packaged assets first and falls back to checkout
sources. The isolated packed-create test runs help and a `--no-install` scaffold
with only Node on PATH and compares every generated file with checkout output.
Tarball dependency resolution supports npm only; pnpm and yarn remain refused.

## Verification evidence and limits

Repository `create-clean` CI covers npm tarballs for all eight kind/framework
combinations on Ubuntu Node 24 and both LangGraph.js kinds on Node 22. The pack
test inspects thirteen packages, and the isolated packed-create test runs help
and scaffolding outside the checkout. [Standalone runs](standalone-verification.md)
record local mock-backed results. New-release registry installs, real models,
devices, pnpm/yarn tarball mode and non-Linux CI remain unverified.

## Prepared adapters

The three additional adapters are prepared for the 0.2.0 lockstep release.
The Python adapter exposes `./runtime-files` for runtime and wheel inventories.
Its vendored `cryptography` wheel URL is repository-relative
(`../python/wheels/...`), so direct registry consumers cannot resolve it from the
installed adapter alone. They must arrange hosting and wheel URLs themselves;
this preparation does not resolve that distribution limit. Generated LangGraph
Python projects obtain their wheels from `starter-python` instead.

The Python starter's limited same-name `ormsgpack` stand-in has an unconfirmed
license and unverified checkpoint serializer compatibility. Its certifi/orjson
MPL-2.0 texts and the adapter's unmodified registry `pyodide` MPL-2.0 exception
require maintainer review before redistribution. The dependency-license gate's
exception records the file-level weak-copyleft rationale; it does not replace
that review. **Record the Python starter license review before publishing
`starter-python`. The whole lockstep release waits for it**, because create's
`langgraph-python` layer depends on that starter; omitting it breaks registry
installation for that framework.

## Size budgets

CI and `pnpm check` measure every default JavaScript export of each public package
against [scripts/size-budget.json](../scripts/size-budget.json). Each entry bundles
only its own code, with bare imports external, and reports minified and level-9
gzip bytes. Dependency growth and the final application download size are outside
this regression guard.

After reviewing deliberate package growth or a changed export inventory, regenerate
the budget from a fresh build:

```sh
pnpm run build:packages && node scripts/check-size.ts --write
```

Generation preserves `marginPercent` (10 percent initially), adds that margin to
each measurement and rounds each limit up to the next 100 bytes. Review deliberate
growth in the diff before committing and rerun `pnpm run check:size`. Do not
regenerate merely to clear a failed check. Use the pinned Vite version; bundler
or platform changes can affect output and require reviewing measurements again.

## Maintainer-only prerequisites

Start from green `main` after the release-preparation pull request has merged.
The release commit must have no uncommitted edits. Require green `pnpm check`, all
five `create-clean` CI legs with `success` (not skipped), and every other CI job.
Record the Python starter license review above before beginning the whole release.
The maintainer needs an npm account permitted to publish under `@galaxie-ai`,
with two-factor authentication enabled. The repository is already public.

## Manual publish steps

1. Check out the reviewed release commit on green `main`. Confirm all thirteen
   manifests and their constants are 0.2.0 and the prerequisites above are met.
2. Run `pnpm install --frozen-lockfile`, rebuild both starters through `prepack`,
   then run `pnpm check` with Go 1.27.3 on PATH. Run `pnpm run build`.
3. Verify generated projects against packed workspace packages with Node 22 and
   24 installed locally and npm 12 on PATH:

   ```sh
   node scripts/verify-standalone.ts --node 22 --node 24 --mode tarball --clean-path --json /tmp/galaxie-standalone-tarball.json
   ```

   Repeat with `--framework adk-js`, `--framework adk-go` and
   `--framework langgraph-python`. Review every gating failure and the limits in
   the [standalone verification record](standalone-verification.md). Generated
   checks and both CSP mutation controls must pass. The harness never publishes.
4. Run `pnpm pack` in each of the thirteen package directories and inspect the
   tarballs. Require `dist`, `LICENSE`, `NOTICE`, `README.md` and `package.json`,
   with no top-level `src`, tests or internal files. Create additionally ships
   its templates and skill trees, including source and tests used to generate
   projects. Require matching versions, exact internal dependencies and no
   remaining `workspace:` references. Run the package-pack and isolated
   packed-create conformance tests. Record the kit and LangGraph consumer's
   minified/gzip bundle measurements; these include the kit and differ from the
   own-code size budgets, so they do not establish a size saving.
5. Publish each package in the exact order above, running
   `pnpm publish --access public` in its package directory. This is a maintainer
   action, never part of the preparation scripts. Publishing before dependencies
   makes installations fail until those dependencies exist in the registry.
6. Perform the post-publish checks below before tagging. Record any failures.
7. The maintainer tags the same release commit `v0.2.0` and pushes that tag only
   after all thirteen packages and post-publish checks are verified.
8. The maintainer writes English release notes and creates the release, naming
   all thirteen packages, breaking public API changes, coordinated upgrade
   ranges, tarball evidence, license review and documented verification limits.

## Post-publish checks

Check `npm view @galaxie-ai/<package>@0.2.0 version` for every package in the
publish order and inspect the registry manifests for matching versions, exact
internal dependencies, public access, exports and create's bin. Run
`npm create @galaxie-ai@0.2.0 -- --help` outside the checkout.

Run the public-registry LangGraph JavaScript check:

```sh
node scripts/verify-standalone.ts --node 22 --node 24 --mode registry --clean-path --json /tmp/galaxie-standalone-registry.json
```

The seven-day release-age policy normally requires waiting for a release to age.
If deliberately checking sooner, pass `--min-release-age-exclude '@galaxie-ai/*'`
explicitly and retain that recorded exclusion with the evidence. Do not relax
`minimumReleaseAge` or change user npm configuration. The other three frameworks
remain tarball-only in this harness; registry installation of their generated
projects requires separate evidence before claiming it verified. A scheduled
registry CI run remains follow-up work once this release exists for the workflow.
Manual publishing from a laptop has no provenance attestations.

See [the license and DCO decision](adr/0024-apache-2-0-license-and-dco.md).
