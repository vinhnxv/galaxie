# Next.js App Router

The private [Next.js example](../../examples/nextjs-app-router/README.md) runs
LangGraph.js and ADK JS agents client-only on Next **16.4.6** and React **19.3.1**.
Both routes use a deterministic mock. It demonstrates the client boundary,
request nonces, enforced production Trusted Types and a same-origin ping Worker
in Chromium. It does not establish that an app or galaxie is secure or suitable
for regulated or high-risk use.

Keep the [mandatory baseline](../adr/0012-security-baseline.md) and the
[host integration guide](host-integration.md) alongside this guide. The host
owns authentication, backend authorization, reviewed code, lifecycle and
deployment policy. Same-origin code and dependencies remain trusted and can
bypass SDK-controlled paths.

## Run the example

Use the repository's Node 24 and pnpm 11 environment with dependencies installed.
From the repository root, build the workspace exports and start production:

```sh
pnpm run build:packages
pnpm exec tsc -p packages/adapter-adk/tsconfig.build.json
pnpm --filter @galaxie-ai/example-nextjs-app-router build
pnpm --filter @galaxie-ai/example-nextjs-app-router start
```

The example's `build` script runs `NEXT_TELEMETRY_DISABLED=1 next build --webpack`;
`start` runs `NEXT_TELEMETRY_DISABLED=1 next start`. Open the printed origin and
follow **LangGraph.js** (`/langgraph`) or **ADK JS** (`/adk`). Select **4** and
**Submit answers**. Both show `Keep practicing one small step at a time.` and
`Worker: pong`. No provider key, model download or agent backend is needed.
Reload starts again: checkpoints are in memory, with no persistence or tab
ownership.

Stop production before starting development:

```sh
pnpm --filter @galaxie-ai/example-nextjs-app-router dev
```

The `dev` script runs `NEXT_TELEMETRY_DISABLED=1 next dev` with Turbopack. Its
policy differs from production as described below. The verification command is:

```sh
pnpm --filter @galaxie-ai/example-nextjs-app-router test
```

Its `pretest` builds workspace packages and the ADK adapter. The tests run the
same `next build --webpack`, `next start` and `next dev` commands on ephemeral
loopback ports, with `NEXT_TELEMETRY_DISABLED=1`. They use unique ignored
`.next-test/<id>` directories through `GALAXIE_NEXT_DIST_DIR`, remove their
outputs and assert unchanged Git status and app-directory entries. The app
otherwise builds into `.next`; Next's generated `next-env.d.ts` is ignored.

## Client-only boundary

The [route page](../../examples/nextjs-app-router/app/langgraph/page.tsx) is a
Server Component. It calls `await connection()` from `next/server`, renders the
heading and memory-only shell, and passes the framework name to
[`ClientAgent`](../../examples/nextjs-app-router/src/client.tsx). The index also
uses `connection()`. These pages render at request time so Next can put the
request's nonce on its scripts; do not statically prerender them.

The wrapper starts with `'use client'` and configures Zod with
`z.config({ jitless: true })` before loading the agent modules. It uses
`dynamic(() => import('./langgraph-host.js'), { ssr: false })` and the equivalent
ADK import. Keep `ssr: false` inside this client wrapper, rather than in the Server
Component. Keep runtime and adapter value imports in the dynamically loaded
host modules. A client directive alone does not prevent server prerendering.

The [framework host](../../examples/nextjs-app-router/src/langgraph-host.tsx)
creates the runtime and registry, binds the mock through the model router and
disposes the runtime on unmount. The
[shared host component](../../examples/nextjs-app-router/src/host.tsx) prepares
and starts the instance in an effect, renders the registered Quiz and checked
result as React text, and terminates its Worker during cleanup. Replace the
fixed demo principal with trusted host identity before adding user data; follow
the host guide for persistence, ownership and logout.

The app consumes built workspace `dist` exports, as an installed consumer would.
`tsconfig.check.json` separately resolves workspace sources so repository type
checks do not need a prior build. These results do not measure installing the
packages or skill into an independent Next app.

## Nonce CSP in proxy.ts

[`proxy.ts`](../../examples/nextjs-app-router/proxy.ts) creates a fresh
`Buffer.from(crypto.randomUUID()).toString('base64')` nonce per request. It puts
`x-nonce` and the policy header on the forwarded request and the same policy on
the response. Next reads that request policy to nonce its framework and inline
scripts. A response header alone would leave those scripts without the nonce.

Production sends **`Content-Security-Policy`**. The exact directive map lives in
[`src/policy.ts`](../../examples/nextjs-app-router/src/policy.ts):

| Directive | Production value |
| --- | --- |
| `default-src` | `'none'` |
| `script-src` | `'self' 'nonce-<request nonce>'` |
| `worker-src`, `connect-src`, `style-src`, `img-src`, `font-src`, `manifest-src` | `'self'` |
| `media-src`, `form-action`, `frame-src`, `frame-ancestors`, `base-uri`, `object-src` | `'none'` |
| `require-trusted-types-for` | `'script'` |
| `trusted-types` | `nextjs#bundler` |

There is no `'unsafe-inline'`, `'unsafe-eval'` or `'wasm-unsafe-eval'` in this
production policy. The mock and ping Worker need no WASM compilation. Avoid
inline styles and `next/font`; this example needs only `style-src 'self'`.
Do not add eval or inline permissions to make a production test pass.

The matcher is `['/((?!_next/image|favicon.ico).*)']`. It deliberately includes
`/_next/static`: a dedicated Worker takes its policy from its own response.
The tests compare page and Worker directives; only their response-specific
nonces differ. Keep this coverage when changing asset routing or hosting.

## Trusted Types and workers

The measured production allowlist is **`nextjs#bundler` only**. Chromium blocked
that policy name with an empty allowlist; with this one name allowed, both
routes and the Worker answer with zero policy violations and zero page errors.
The tests record each created policy and reject additional names. These routes
do not create `nextjs`, so it is not allowed. No `default` policy is needed.
Re-measure when changing Next versions or adding framework features.

The host creates its ping Worker with
`new Worker(new URL('./ping-worker.ts', import.meta.url))`. Webpack emits a
same-origin asset and passes its URL through Next's identity
`nextjs#bundler` policy. That policy does not validate arbitrary URLs. This is a
broader trust grant than the Vite templates' `default` policy, whose sole
`createScriptURL` rule accepts the exact bundled Worker URL. Do not describe
the two patterns as equivalent.

The tests prove enforcement independently: assigning a plain string to a
script's `src` throws `TypeError`, and constructing a Worker with another
same-origin string URL is rejected. Those deliberate violations run after the
happy-path recorder is checked. The identity policy remains trusted code;
Trusted Types does not turn its accepted URLs into reviewed destinations.

## Development and Turbopack limits

Development sends **`Content-Security-Policy-Report-Only`** on the forwarded
request and response, with no enforcing `Content-Security-Policy`. It retains
`require-trusted-types-for 'script'` and `trusted-types nextjs#bundler`, and adds
`'unsafe-eval'` to `script-src` for development only. All other directives have
the same values as production.

Turbopack development reports script URL, eval and Worker sinks; Next's overlay
also reports inline styles. Report-only headers report these operations without
blocking them. Both mock routes answer in the dev test, but that is not evidence
of production enforcement. Use the webpack production test for that obligation.

Turbopack production does not meet this integration's Trusted Types obligation;
see [vercel/next.js#101261](https://github.com/vercel/next.js/issues/101261).
The example therefore builds production with `--webpack`. It does not verify a
Turbopack production build or a workaround for that issue.

## WASM assets, Go and Python

The ping Worker is an asset-loading stand-in, with no WebLLM, Pyodide or Go
runtime. For an attempted Go or Python integration, copy the pinned runtime,
WASM, glue and wheel assets into the Next app's `public/` directory and use their
same-origin public URLs from a client-only host. Follow the adapter's integrity,
MIME, Worker-response CSP and Trusted Types requirements. A public asset URL
still needs reviewed loading code; serving the bytes alone is insufficient.

This `public/` asset-copy path is **unverified** for Go and Python in Next. No
copy/build commands or successful agent run are established here. Do not infer
that the webpack Worker URL path covers those loaders. A real WASM engine may
need a narrowly scoped `'wasm-unsafe-eval'` Worker response policy; the
[host guide](host-integration.md#model-hosting-and-integrity) describes model
assets, integrity limits and conditional isolation requirements. Keep general
JavaScript eval and inline-script permissions absent from production.

## What the example reuses

The LangGraph.js and ADK JS agent/executor sources, including `adk-env.ts`, are
byte-identical copies of the framework template sources, guarded by the
[source drift test](../../examples/nextjs-app-router/test/sources.node.test.ts).
Bare imports resolve from this app's dependencies with both bundlers; importing
the template sources outside the app would resolve from a different dependency
directory. Keep the copies identical and update them together with the templates.

ADK's browser export is selected without an alias. Next's bundler-neutral `env`
setting inlines `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false'` for both bundlers.
Webpack's `experimental.extensionAlias` resolves authored `.js` imports to
TypeScript. Turbopack uses the small TypeScript-parser loader in
`src/relative-imports.cjs` to remove relative import suffixes during compilation,
preserving the authored files. `agentRules: false` prevents Next dev from writing
its own generated `AGENTS.md` into the app.

## Evidence and limits

The [app tests](../../examples/nextjs-app-router/test/app.node.test.ts) check both
mock routes in production and development, request-unique nonces, executable
inline-script nonces, the exact production directives, enforcement negative
controls, Worker response policy and same-origin JavaScript content type. They
check raw server HTML, server runtime markers and traced dependencies for the
client-only boundary. The index and navigation are covered too. The tests run in
`pnpm check` and the `nextjs` CI job; Linux results come from that job.

Measured scope is the mock in Chromium on Next 16.4.6 only. Other Next versions,
Firefox, WebKit/Safari, real models and devices, Go and Python in Next, hosted
deployment platforms and Turbopack production remain unmeasured. Installing the
skill into a Next app and an agent consuming it are also unmeasured. The mock
checks wiring, not model quality or performance. Nothing is published by this
example, and ADR-0012 guarantees are unchanged.
