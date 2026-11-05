# ADK recipe host scaffold

This example currently contains provenance, a Vite host and fixture capabilities. **No agents are installed yet.** It contains no ONNX records, provider changes or model downloads. Default mode lists no model provider; mock mode lists the deterministic in-browser mock. The page reports missing optional recipe assets without trying to load a Worker.

All companies, applicants, application documents and market bulletins are invented. There is no real personal data or real news. Outputs are not financial advice and must not be used for real lending decisions. galaxie is not affiliated with or endorsed by Google. The page retains the upstream financial disclaimer verbatim; see [attribution](ATTRIBUTION.md) and [ADR-0025](../../docs/adr/0025-adk-recipes-demo.md).

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @galaxie/example-adk-recipes dev:mock
pnpm --filter @galaxie/example-adk-recipes exec vite build --mode mock
pnpm exec vitest run examples/adk-recipes
```

`dev:mock` serves a built preview so the unchanged strict script policy needs no development-client exception. Both modes allow connections only to the same origin, require Trusted Types for scripts and permit only same-origin Workers. There is no `unsafe-eval`. The ADK runtime setup disables span content capture and uses jitless Zod; the Vite alias selects ADK's pinned web bundle. Only recipe authoring files may import the ADK root package.

| Capability | Input | Result and policy |
| --- | --- | --- |
| `market.search@1` | Non-empty query, at most 160 characters | Case-insensitive substring search over synthetic bulletins; `public`, explicitly untrusted tool output |
| `loan.documents@1` | Synthetic application ID | Fixture documents; `private-user` |
| `loan.business@1` | Synthetic application ID | Fixture internal business data; `private-user` |
| `loan.price@1` | Integer credit score 300–850, amount 1000–250000 demo dollars, term 12–60 months | Pure synthetic annual-rate tiers: 300–649 review at 12.5%, 650–749 standard at 9.5%, 750–850 preferred at 6.5%; `private-user`. Amount and term are validated context, not inputs to the tier threshold |
| `loan.finalize@1` | Application ID and `approved` or `denied` | Host-memory decision record; `private-user`, write, broker confirmation required, retry `none` |

Collections contain at most five items and at most 4096 UTF-8 bytes including the JSON envelope. Excess whole items are omitted with `truncated: true` and `[truncated]`. The oversized synthetic bulletin exercises the byte limit. Unknown application reads return the fixed empty `not_found` envelope. Invalid arguments produce a fixed `invalid` error. Principal scope comes from trusted host context, not arguments; bindings reject other principals. There is no backend, durable decision journal or approval UI yet. Direct invocation of a host binding bypasses broker approval; agent callers must use the broker. Recovery, actual loan approvals and at-most-once replay are later agent work.

Pricing is authored synthetic fixture logic. Upstream was read only for licenses and notices, so no claim is made that these tiers reproduce its implementation.

The Python Vite plugin selects only ADK wheels from the existing inventory and this example's `agent_py` sources. It requires local wheels, verifies their hashes and lengths, and uses the existing same-origin Pyodide runtime. It omits the lane if prerequisites are absent. No Python recipe sources ship yet. The Go plugin similarly waits for `go/recipes/financial` and the installed toolchain, then uses the existing locked build helper with module downloads disabled, verifies the glue and emits length/SHA-256 metadata for adapter preparation. It adds no Go source or lock changes. The current scaffold does not prepare either executor or claim execution evidence.
