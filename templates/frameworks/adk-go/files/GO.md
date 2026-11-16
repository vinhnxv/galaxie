# Editing the Go agent

The unedited agent runs from the private `@galaxie-ai/starter-go` prebuilt artifact.
Running it needs Node and npm, without Go. The starter package and Go adapter are
unpublished; install from the maintainer-provided npm tarballs.

Run `npm run dev` to build, then preview at `http://127.0.0.1:4173` under the strict
CSP and Trusted Types headers. There is no watch or HMR mode. Stop preview and run
`dev` again after editing. The mock quiz needs no model download or external service.

To edit `go/agent.go`, install Go 1.27.3 and put it on PATH. The build accepts exactly
that version, never downloads a toolchain, and uses the checked `go.sum`. The first
local build may download modules through your GOPROXY; offline builds are not promised.
Go compiler diagnostics are passed through unchanged.

Resolution uses a verified local cache first, then a source-matching prebuilt,
then Go 1.27.3. The page logs the chosen origin and wasm SHA-256. An edited agent
without the pinned toolchain fails with this exact message:

> The agent source in go/ was edited and Go 1.27.3 was not found on PATH. Install Go 1.27.3, or restore the original go/ source to use the prebuilt agent.

The source hash covers every regular file in `go/` except `.git`, `.DS_Store` and
`node_modules`, the starter package version and its bundled Go module.
Symlinks in the source tree are refused. Restore the original bytes to use the prebuilt.

`go/go.mod` replaces `galaxie.invalid/galaxie` with the installed package's
`node_modules/@galaxie-ai/starter-go/dist/go-module`. npm directories and pnpm
symlinks are supported by the build helper. Yarn needs `nodeLinker: node-modules`;
Bun and Windows are unsupported. Tarball installation currently supports npm only.

Upgrading starter-go also upgrades that Go module. An unedited agent keeps using
the prebuilt after a version bump only when the release's template `go/` tree is
byte-identical to your project. A release that changes the template requires Go
for an older project, or restoring the new release's original source.

Deploy the emitted `go/NOTICE.txt` with the wasm. The Worker verifies the bundled
module's length and digest before compiling; this binds it to the reviewed build
and does not prove safe behavior. Agents remain trusted, reviewed application code.
ADR-0012 guarantees are unchanged.
