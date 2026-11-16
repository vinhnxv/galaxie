# Next.js App Router

Read only when the host is a Next.js App Router app.

<!-- galaxie:cite path="docs/adr/0012-security-baseline.md" heading="Decision" sha256="a92d75c3ffb3f5b696b8b7637d3e0ccb093e274a892bbcf241cc63c26b1cbdc2" -->
<!-- galaxie:cite path="docs/guides/host-integration.md" heading="CSP and Trusted Types" sha256="71ed3a1377cae6187e2530e3fd5d4e684bbdc09fa8ace01033c814e08c9862fe" -->
<!-- galaxie:summary:start -->
Keep the runtime client-only behind a client wrapper's `dynamic(..., { ssr: false })`.
Use request-time rendering and a fresh nonce policy on the request and response.
Production uses webpack and enforcing CSP/Trusted Types; development is report-only.
Re-measure policy names when changing Next or features. Keep host authorization,
reviewed code, credentials, lifecycle and the baseline obligations intact.
<!-- galaxie:summary:end -->

<!-- galaxie:cite path="docs/guides/nextjs.md" heading="Client-only boundary" sha256="e014920bd77392cae8c74022f0ea6f4dbad2946230e1e3d6d053d07d1bf48ea7" -->
Follow the [client-only boundary](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#client-only-boundary):
the Server Component renders a shell and calls `connection()`; a `'use client'`
wrapper configures Zod jitless before dynamically importing the runtime/adapter
host with `ssr: false`. A client directive alone does not prevent prerendering.
Keep runtime teardown and Worker termination on unmount. The example uses memory
checkpoints and a fixed demo principal; follow the host guide before adding user data.

<!-- galaxie:cite path="docs/guides/nextjs.md" heading="Nonce CSP in proxy.ts" sha256="12f359bcfe90db8821b908c2fcecd3c187cdd052fae0349aee9807ae045a2cb1" -->
Follow the [nonce flow](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#nonce-csp-in-proxyts)
in `proxy.ts`: fresh nonce, `x-nonce` and the policy on the forwarded request,
the same policy on the response. Keep dynamic rendering so Next nonces its scripts.
Production has no `'unsafe-inline'` or `'unsafe-eval'`. Include `/_next/static`
in the matcher so the Worker response receives its own policy. Keep the
[host CSP obligations](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/host-integration.md#csp-and-trusted-types).

<!-- galaxie:cite path="docs/guides/nextjs.md" heading="Trusted Types and workers" sha256="a03c4ec176896f828cef5992151b7ea8ec3f644f1daf0bdddd34eb8d1b759add" -->
The measured [Trusted Types allowlist](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#trusted-types-and-workers)
on Next 16.4.6 is `nextjs#bundler` only, with neither `nextjs` nor `default`.
Webpack passes the bundled ping Worker URL through that identity policy. It
does not validate arbitrary URLs and is broader than the Vite template's exact-URL
Worker policy. Preserve enforcement tests that reject plain script/Worker URL
strings, and re-measure before changing the allowlist.

<!-- galaxie:cite path="docs/guides/nextjs.md" heading="Development and Turbopack limits" sha256="a3c956dfd1775de44bc7820489eaac73fe8a4324df5335684848fe0a337a46c7" -->
Use the app's scripts and the [tested commands](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#run-the-example).
Production is `next build --webpack` plus `next start`. Development is `next dev`
with `Content-Security-Policy-Report-Only`, including Trusted Types and a dev-only
`'unsafe-eval'` source, with no enforcing CSP header. Dev reports do not establish
production enforcement. Turbopack production does not meet the Trusted Types
obligation; the [guide records the upstream issue](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#development-and-turbopack-limits).

<!-- galaxie:cite path="docs/guides/nextjs.md" heading="WASM assets, Go and Python" sha256="2af5a6d04a7ff9a082632ba17962213861b0169a71afb8dc650a59ce66ad5503" -->
Go and Python have only an [unverified public asset-copy path](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#wasm-assets-go-and-python).
The ping Worker does not verify WASM, Pyodide, Go or model loading. Preserve
adapter integrity and Worker-response policy checks; do not loosen production
eval or inline-script restrictions to add an engine.

The framework agent sources are copies with a drift test, as the
[reuse note](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#what-the-example-reuses)
explains. Verification covers only the mock in Chromium on Next 16.4.6. Read the
[evidence and limits](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/nextjs.md#evidence-and-limits)
before describing coverage: other Next versions, Firefox/WebKit, real models and
devices, Go/Python in Next, hosted deployment and Turbopack production are unmeasured.
Skill installation into a Next app and agent consumption remain unmeasured.
Nothing is published; ADR-0012 guarantees are unchanged.
