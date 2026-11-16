# Next.js App Router example

A private workspace example on Next.js 16.4.6 and React 19.3.1. Both `/langgraph`
and `/adk` run a reviewed, bundled agent on the page with a deterministic mock.
Choose **4** and submit to see `Keep practicing one small step at a time.`
No model download, provider credential or agent backend is needed. Reload starts
again: this example has memory checkpoints, no persistence or tab ownership.

From the repository root:

```sh
pnpm install
pnpm run build:packages
pnpm exec tsc -p packages/adapter-adk/tsconfig.build.json
pnpm --filter @galaxie-ai/example-nextjs-app-router build
pnpm --filter @galaxie-ai/example-nextjs-app-router start
# Or use Turbopack during development:
pnpm --filter @galaxie-ai/example-nextjs-app-router dev
pnpm --filter @galaxie-ai/example-nextjs-app-router test
```

The app consumes built workspace `dist` exports, as an installed consumer would.
The separate `tsconfig.check.json` resolves sources for build-independent checking.
Server pages render a shell and a client wrapper; only the wrapper's
`dynamic(..., { ssr: false })` imports load the runtime. Agent pages use
`connection()` to opt into request-time rendering.

## Response policy

`proxy.ts` puts a fresh nonce policy on both the request and response, so Next
nonces its inline scripts. Production uses `next build --webpack` and an enforcing
CSP with no general eval or inline-script permission. Its measured Trusted Types
allowlist is **`nextjs#bundler` only**: Chromium blocked that name with an empty
allowlist, then both mock routes and the worker completed without page errors or
policy violations with that one name allowed. These routes do not use the `nextjs`
policy; it is deliberately not allowed. No `default` policy or WASM eval permission
is needed. Re-measure when adding Next features or changing versions.

The same-origin ping worker stands in for an asset-loading path. Webpack passes
its URL through Next's identity `nextjs#bundler` policy. This is broader than the
Vite templates' exact-URL worker policy. The matcher includes `/_next/static`, so
the worker response carries its own CSP. This is not a measurement of WebLLM,
Pyodide or Go workers. Next's identity policies do not validate arbitrary URLs.

Development sends only `Content-Security-Policy-Report-Only`, including the Trusted
Types directives and a development-only `'unsafe-eval'` source. Turbopack reports
script URL, eval and worker sinks, and Next's development overlay reports inline
styles; these reports do not block the mock. Development is deliberately different
from the enforced production build. Turbopack production is outside this example;
see [Next issue 101261](https://github.com/vercel/next.js/issues/101261).

## What the example reuses

The agent and executor files under `src/langgraph-js` and `src/adk-js` are byte
copies of the framework templates, guarded by a drift test. Their bare imports
resolve from this app's dependencies under both bundlers. ADK's browser export is
selected without an alias, and its content-capture environment value is inlined
through Next's bundler-neutral `env` setting. Zod runs in jitless mode before the
agent chunks load.

Webpack's `extensionAlias` resolves the repository's authored `.js` imports to
TypeScript. Turbopack lacks that option; the small `src/relative-imports.cjs` loader
uses the installed TypeScript parser to remove only relative import specifier
suffixes during compilation. It preserves the authored copies. `agentRules: false`
prevents Next dev from writing a generated `AGENTS.md` into the app.

## Limits

Verification covers mock agents in Chromium on this pinned Next version.
Real models, device performance, other Next versions, Firefox, WebKit, Go and
Python in Next, deployment platforms and Turbopack production remain unmeasured.
The host owns authentication, backend authorization, reviewed code, lifecycle and
deployment policy. Same-origin code can bypass SDK paths. Read the
[mandatory baseline](../../docs/adr/0012-security-baseline.md) and
[host integration guide](../../docs/guides/host-integration.md).
Nothing is published; ADR-0012 guarantees are unchanged.
