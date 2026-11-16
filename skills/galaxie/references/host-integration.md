# Host integration

<!-- galaxie:cite path="docs/guides/host-integration.md" heading="CSP and Trusted Types" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
<!-- galaxie:summary:start -->
Keep the existing CSP and Trusted Types baseline. Serve CSP as a response header;
Vite dev/preview headers do not configure a deployment. Allow only reviewed
Worker URL policies and registered components rendered as text. Same-origin code
and dependencies remain trusted; CSP does not authorize URL paths or queries.
<!-- galaxie:summary:end -->

<!-- galaxie:cite path="docs/guides/host-integration.md" heading="Host confirmations" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
Significant write bindings use `approval: 'confirm'` plus
`CreateOptions.confirmations` for the full capability names, policy revision,
expiry and logout/ownership signals. Mount a separate host `ConfirmationPrompt`
outside `AgentSurface`. An approval is single-use and memory-only; dispose on
logout/takeover. Decline cannot undo a request already sent. Backends still check
authentication, authorization and idempotency.

<!-- galaxie:cite path="docs/guides/host-integration.md" heading="Credentials for APIs, MCP and remote models" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
Attach credentials at host transports, never in agent arguments or state. HTTP
bindings can use `credentials: 'omit'` and a host `headers(context)` callback;
MCP uses per-principal `token` callbacks. Remote models use `getCredential` or a
separate HttpOnly model-session cookie at a same-origin host proxy. Application
keys stay server-side. Page code can read a bearer during a call; same-origin
scripts can use a cookie-authenticated proxy while its session lasts.

<!-- galaxie:cite path="docs/guides/host-integration.md" heading="Output safety and display" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
Preserve `RuntimeOptions.outputSafety` for routed text and tool-call arguments.
It checks growing chunks and the final reply; earlier allowed chunks cannot be
retracted. Direct models, capability results and other display callbacks are
outside that hook. Use trusted display projections and the bound registry;
keep raw graph streams and checkpoints out of display and telemetry.

See the [host guide](https://github.com/vinhnxv/galaxie/blob/main/docs/guides/host-integration.md)
for wiring and limits.
