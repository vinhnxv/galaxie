# Releasing galaxie

Nothing is published yet. Publishing is a manual maintainer step.

The seven launch packages are `@galaxie/ui-protocol`, `@galaxie/core`,
`@galaxie/adapter-kit`, `@galaxie/adapter-langgraph`,
`@galaxie/models`, `@galaxie/storage-indexeddb` and `@galaxie/react`. All other
packages stay private and unpublished.

## Versioning

Versions are `0.MINOR.PATCH`. While the major version is 0, a breaking change to a
public API may land in a minor release and must be called out in the release
notes. A patch release does not break a public API. The seven launch packages share
one version number and are released together, because `@galaxie/adapter-langgraph`,
`@galaxie/adapter-kit` and `@galaxie/react` depend on the exact `@galaxie/core`
version of the same release; the LangGraph adapter also depends on the kit.
`@galaxie/ui-protocol` has no galaxie dependencies and no hand-written package-version
constant. Its spec pin constants are not the package version. Core and the React
package will depend on it in a later release.
The planned change to the public surface API is expected to land in a 0.x minor.

## Maintainer-only prerequisites

The maintainer must provide an npm account with permission to publish under the
`@galaxie` scope, with two-factor authentication enabled, and make the repository
public. These are maintainer-only steps.

## Manual publish steps

1. Start from a green `main`.
2. Bump the version in all seven launch package manifests to the same release version,
   and set the same version in `packages/core/src/version.ts` and in the adapter object
   in `packages/adapter-langgraph/src/adapter.ts`. Core reports its constant as the
   instrumentation scope version and the adapter advertises its own, and tests fail
   when either differs from its manifest. Commit the bump with `git commit -s`, merge
   it through a pull request, and check out the merged commit. That commit is the
   release commit: everything below publishes and tags it, with no uncommitted edits.
3. Run `pnpm install --frozen-lockfile`, then `pnpm check`.
4. Run `pnpm run build`.
5. Run `pnpm pack` in each launch package directory and inspect each tarball. It
   must contain `dist`, `LICENSE`, `NOTICE`, `README.md` and `package.json`, with no
   `src`, tests or internal files. No `workspace:` reference may remain in the
   packed manifest.
   The Node package-pack conformance test also reports minified and gzip bytes
   for the kit and the LangGraph consumer with the kit bundled in. Record both
   measurements with the release evidence. No numerical release size limits are
   currently recorded; these measurements do not establish a size saving.
6. Publish `@galaxie/ui-protocol` first, then `@galaxie/core`, then `@galaxie/adapter-kit`,
   then the other four launch packages, running `pnpm publish --access public` in each
   package directory.
   pnpm rewrites each `workspace:` reference to the exact dependency version when
   it packs and does not check the registry, so a package published before its
   dependencies installs only once those are published. That is why the order matters.
7. Tag the release commit `v<version>` and push the tag.
8. Write release notes in English, including any breaking public API changes.

Manual publishing from a laptop has no provenance attestations.

See [the license and DCO decision](adr/0024-apache-2-0-license-and-dco.md).
