# Contributing to galaxie

## Setup and checks

Use Node.js 24 and pnpm 11 through Corepack:

```sh
corepack enable
pnpm install
pnpm check
pnpm format
```

`pnpm check` runs the same checks as CI: source and dependency licenses, Biome,
TypeScript 7 and 6, Node and Chromium tests, Python and Go tests, Python type
checking, builds, dependency boundaries and documentation links. Run it before
opening a pull request. `pnpm format` applies formatting and safe fixes.

The Pyodide tests load the galaxie Python wheel from the git-ignored
`.cache/python-wheels/`. CI rebuilds it; on your machine run
`node scripts/build-python-wheels.ts` after you change `python/galaxie` or pull
such a change. `pnpm check` stops early when that wheel is older than its source.

## Language and source headers

Everything committed is English: code, comments, docs, commit messages, issues
and pull requests.

New source files start with the SPDX header below, using the comment syntax for
their language. Markdown and YAML files carry no header. `pnpm run check:license`
checks source headers and package license declarations.

```ts
// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
```

## Conformance cases

Follow the [conformance guide](tests/conformance/README.md). For a graph parity
case, add a deterministic fixture under `tests/conformance/cases/` and register it
in `tests/conformance/cases/index.ts`. The native Node lane owns the golden
transcripts; the galaxie Node and Chromium lanes compare against them. Update an
intentional native baseline with `pnpm conformance:update`, register the new
golden in `tests/conformance/galaxie.test.ts` and review the diff.
Record observed lane differences as exact JSON paths with reasons in
`tests/conformance/compatibility-matrix.json`; stale or unlisted differences fail.
Runtime control work leaves existing goldens and the matrix unchanged.

Run `pnpm test tests/conformance/galaxie.test.ts` for the parity lanes, or
`CI=true pnpm test` for both test projects without writing missing goldens.
Additional control tests run on Node and Chromium unless named `*.node.test.ts`
or explicitly limited to Chromium, as described in the guide.

## Injection-corpus cases

Follow the [injection-corpus guide](tests/injection-corpus/README.md). Add a
data-driven entry to `tests/injection-corpus/cases.json` with a unique kebab-case
`id`, a supported `vector`, a `goal`, a synthetic `payload` and a closed structured
`directive`. Use only the guide's synthetic values and domains. Keep the coverage
requirements and existing assertions. Run both lanes with:

```sh
pnpm exec vitest run tests/conformance/injection-corpus.test.ts
```

If a case demonstrates a control failure, retain the assertion, use `test.fails`
with a comment naming the gap and report it in a draft pull request, as the guide
requires. Follow [SECURITY.md](SECURITY.md) privately for vulnerabilities; never
disclose a vulnerability through a public issue or pull request.

## Developer Certificate of Origin sign-off

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
By signing off, you certify that you have the right to submit the contribution
under the project's license. Contributions are licensed to the project under
Apache-2.0; no CLA is required. See the
[license and DCO decision](docs/adr/0024-apache-2-0-license-and-dco.md).

Every commit, including agent commits, must carry a `Signed-off-by: Name <email>`
trailer whose name and email match the commit author. Names match exactly after
trimming; email matching ignores case. Create it with:

```sh
git commit -s
```

CI checks every non-merge commit in the pull request. Merge commits are skipped.
Run the check locally with:

```sh
node scripts/check-dco.ts origin/main..HEAD
```

To sign off the last commit, use `git commit --amend -s --no-edit`. For existing
commits on your branch, use `git rebase --signoff <base>`, replacing `<base>` with
the branch's base commit. These commands sign as the committer: ensure the
sign-off matches each commit's author; do not sign for another author. After
rewriting commits already pushed, force-push to your own branch with
`git push --force-with-lease`. Coordinate with anyone sharing that branch.
Branches opened before the check landed must be re-signed before their pull
request runs.

## Reporting and project guidance

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report vulnerabilities through [SECURITY.md](SECURITY.md), never public issues.
- Use the [bug](.github/ISSUE_TEMPLATE/bug.yml),
  [feature](.github/ISSUE_TEMPLATE/feature.yml) or
  [integration report](.github/ISSUE_TEMPLATE/integration-report.yml) issue form.
- Coding agents follow [AGENTS.md](AGENTS.md).
