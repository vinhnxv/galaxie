# Spike D: remote model paths and MCP

This is throwaway evidence for M4, implemented independently of the runtime packages. All inference uses a deterministic HTTP fixture. No real model, provider, browser `LanguageModel` global or WebLLM bundle is loaded. The page displays host-authored status text only; model replies never enter the DOM.

## Run offline

Use Node 24 and the installed pnpm 11 dependencies and Playwright Chromium. From the repository root:

```sh
pnpm --dir spikes/d-remote-paths install --offline --frozen-lockfile
node --test spikes/d-remote-paths/scripts/servers.test.ts spikes/d-remote-paths/scripts/canonical.test.ts spikes/d-remote-paths/scripts/exposure.test.ts
pnpm --dir spikes/d-remote-paths exec tsc -p .
pnpm --dir spikes/d-remote-paths record
pnpm format
pnpm check
CI=true pnpm test
```

Run the fixture tests and recorder sequentially: both own ports 4181–4183. The recorder starts Vite on 4180 and 4184, the proxy on 4181, the upstream on 4182 and MCP on 4183, all bound to `127.0.0.1`. It fails clearly if a port is occupied; free these ports before retrying. Every started server and the browser close in `finally`. It writes `results/<date>-headless-chromium-<version>.json`; format that JSON before committing. A normal run takes roughly two minutes because one experiment retains LangChain's default retry backoff.

The browser uses a failing loopback proxy for non-loopback destinations, with a loopback bypass, and the page has a loopback-only connection CSP. Do not use Playwright request interception here: it suppressed preflights in the first characterization runs. The recorder disables Vite WebSockets and removes its injected development client, which otherwise attempts a WebSocket even with HMR disabled. No other hosts are used by the experiments. Dependencies and browser binaries must already be installed; the script never installs them.

## Recorded observations

The committed [recording](results/2026-10-29-headless-chromium-156.0.8078.4.json) contains 30 checks on headless Chromium 156.0.8078.4, Node 24.15.0, LangChain OpenAI 1.6.3, its transitive OpenAI SDK 7.42.0 and MCP SDK 1.32.1. Timings are demonstrations from one local run, with no performance threshold. `observed` means the probe ran and its protocol assertions held; only the credential check is labeled `passed`. Failure to complete a probe or a failed credential assertion exits non-zero. Raw error messages, prompts and replies are never recorded.

| Check | Observation |
| --- | --- |
| Proxy and direct invocation | Deterministic completion; total usage 7 on both paths |
| Proxy and direct CORS | Native OPTIONS preflight observed; only page origin allowed |
| Proxy and direct SSE | Four SDK chunks, including final usage |
| Abort | Upstream connection closes after page abort on both paths; see `upstreamCloseDelayMs` in the recording |
| 401 / 429 / 500 | `AuthenticationError$1` / `RateLimitError$1` / `InternalServerError$1`, with the HTTP status, on both paths with `maxRetries: 0` |
| Default 500 retry | Seven upstream requests, six backoffs; supplier invoked seven times; individual delays recorded |
| No upstream CORS headers | `APIConnectionError$1`, HTTP status unavailable |
| Proxy expired token | 401; upstream is not called |
| Proxy disallowed origin | Alternate-origin browser fetch fails; Node receives 403 |
| Structured output | `response_format.type = json_schema`; Zod validates the parsed reply |
| Credential exposure | Upstream key absent from inspected page responses/headers/console; browser token not forwarded; error fields contain no credential; zero non-loopback page requests |
| MCP initialization | Protocol `2025-11-25`; session ID readable through CORS |
| MCP pins | First-seen disabled; explicit approval enables; changed description disables until re-approved |
| MCP result limits | Wire cap rejects before the result reaches SDK parsing; canonical parsed-result cap rejects before delivery |
| MCP unsolicited sampling | Empty client capabilities; SDK responds `-32601`; fixture observes rejection on the tool call's SSE stream |
| MCP forgotten session | `StreamableHTTPError`, HTTP 404; zero automatic initializations; fresh client/transport restores reads after approval |
| MCP disallowed origin | Alternate-origin SDK client fails without visible status; Node receives 403 |

The `status` field records HTTP status only; `code` separately records numeric SDK/DOM error codes, including abort code 20. Raw SDK errors remain transient page-local values only long enough to inspect own data fields for credentials; the recording retains classes, numeric codes and exposed field paths. This prototype emits no runtime spans, events or snapshots and has no host diagnostic callback. It does not route raw errors into `DiagnosticEvent.error` or attach `cause` to its typed errors. M4 must retain fixed public errors and keep any permitted raw host diagnostic error in the host-only callback field, never in telemetry or serialized state.

Credential inspection runs in Node over CDP response streaming: headers, initially buffered bytes and subsequent chunks are scanned without request interception. A bounded suffix detects a generated key split across chunks. This covers aborted prefixes, standing MCP streams and both page origins; an unreadable or unfinished capture fails the run. A separate Chromium boundary test deliberately returns a generated fake key in finite and aborted bodies and confirms detection. Neither the scanner key nor scanned reply bytes enter recorded observations.

## Remote model findings and M4 slice 1

The observed preflight allowlist for ordinary calls is:

```text
authorization, content-type, x-stainless-arch, x-stainless-lang,
x-stainless-os, x-stainless-package-version, x-stainless-retry-count,
x-stainless-runtime, x-stainless-runtime-version
```

Structured output additionally sends `x-stainless-helper-method: chat.completions.parse`. The fixture also permits `x-stainless-timeout` for configured SDK timeouts. `accept` is present but safelisted. Browser `Origin`, `Referer`, fetch metadata and user-agent headers cross the page-to-proxy hop. The proxy sends only its own fake upstream authorization and JSON content type; it forwards neither the browser bearer token nor the browser headers. The request records show both hops, with authorization reduced to its length.

Each proxy token is random, expires after 60 seconds and binds to the page origin. The proxy admits only POST `/v1/chat/completions`, apart from its token endpoint and preflights. The upstream key is generated in Node process memory and never bundled or returned to the page. The direct-endpoint fake user key exists in process/page memory only: no storage API, URL parameter, file, prompt or recording holds it. This does not protect page credentials from other same-origin code.

Both credential shapes work. Prefetch obtains a token immediately before constructing a call's `ChatOpenAI`. The async supplier is accepted directly by `apiKey`; it runs zero times at construction, once for each request on a reused model and again for every LangChain retry. Type evidence: `@langchain/openai/dist/chat_models/base.d.ts` declares `apiKey?: OpenAIApiKey`; `dist/types.d.ts` aliases `ClientOptions['apiKey']`; transitive `openai/client.d.ts` declares `ApiKeySetter = () => Promise<string>` and `apiKey?: string | ApiKeySetter | null | undefined`. `base.js` sets `dangerouslyAllowBrowser: true` before spreading configuration, so this flag is already implicitly enabled; the explicit flag here documents browser intent.

**Adopt in M4:** retain the host's per-call credential callback and resolve it after policy, consent and budget reservation. Construct a call-scoped ChatOpenAI instance with that credential; set `maxRetries: 0` so one runtime call owns one dispatched request and failures are surfaced to runtime policy. The SDK supplier is technically viable but its retry-driven invocation does not itself define the runtime's budget or consent semantics. Do not share credentials across principals or persist them. Enforce spending limits at the host proxy. Abort propagation here proves socket closure only, not provider cancellation or cessation of billing.

The exact structured request's `responseFormat` is in the recording. It contains `json_schema: { name: 'fixture', strict: true, schema: ... }`, required `answer` and `score`, and `additionalProperties: false`. No prompt or reply is included with that request-shape evidence.

## MCP findings and M4 slice 2

The `node:http` wrapper owns CORS and OPTIONS. It permits GET, POST and DELETE; allows `authorization`, `content-type`, `mcp-session-id`, `mcp-protocol-version` and `last-event-id`; exposes `mcp-session-id`; and rejects origins before handing a request to the SDK. Generated fake 60-second bearer credentials authenticate every non-preflight MCP request. Sessions bind to a fake principal; Node checks verify that missing credentials receive 401 and another principal cannot use the session (403). The Node-only admin endpoint has a separate generated credential and rejects browser origins.

The pin prototype uses SHA-256 over RFC 8785 JCS. It includes name, title, description, input/output schemas and annotations when present, following Accepted ADR-0011. Canonicalization tests cover UTF-16 key ordering, ECMAScript numbers, Unicode rejection and hash stability. Names are `mcp.lessons.lesson.lookup` and `mcp.lessons.progress.record`; dotted names belong to the fixture tools. Only a host-fixed allowlist is eligible. Approved hashes live in a page-memory map and are checked again through listing before each call. Reconnecting discards approvals. This detects definition changes, not changes to behavior behind an unchanged definition. The write tool is listed but never enabled or invoked by the recorder.

`progress.record` increments a principal-scoped in-memory counter. The Node boundary test invokes it twice with a read between calls, verifies counts 1 and 2, and repeats under another principal to prove isolation. The counter disappears when the fixture process closes; no backend write occurs.

The SDK accepts custom `fetch`. A pull-driven response wrapper counts bytes before handing them to the SDK and cancels the body over the cap; it does not buffer an unbounded response. The experiment uses a 1,024-byte wire cap against a 4,096-character tool response. A separate 512-byte canonical parsed-result cap rejects a 2,048-character response allowed by the 32,768-byte wire cap. Counters confirm that neither oversized result reaches delivery and that the wire-rejected result does not reach the parsed-result stage. Production needs caps per message/result plus idle timeouts, schema validation and cancellation notifications; this prototype is not that implementation.

The SDK throws on session 404 and does not initialize again. The prototype replaces the client/transport, initializes, lists, and requires approval again before a read. It never retries a write. The unsupported sampling experiment uses `extra.sendRequest` on the tool call's stream: `server.createMessage`/elicitation convenience APIs can reject locally on capability checks, which would not demonstrate a browser rejection. With no registered request handlers, the SDK client returns method-not-found. Elicitation and roots are not separately injected in this run.

**Adopt the SDK client for M4**, behind the narrow tools-only binding and controls above. A smaller client would need to reimplement negotiated sessions, bidirectional SSE, request correlation, errors, cancellation and re-initialization; this spike does not justify that cost. Keep resources, prompts, OAuth flows and dynamic server registration outside the exposed API.

`vite build` is measured in memory with minification and no source maps; gzip is the sum of gzip sizes of emitted JavaScript chunks (HTML excluded):

| Entry | Minified JavaScript | Gzip JavaScript |
| --- | ---: | ---: |
| Whole experiment page | 1,348,474 bytes | 337,996 bytes |
| Isolated exported MCP prototype | 301,243 bytes | 85,580 bytes |

The isolated prototype includes the SDK, `zod`, `ajv`, `ajv-formats`, `content-type`, `eventsource-parser`, `fast-deep-equal`, `fast-uri`, `json-schema-traverse` and `pkce-challenge`. `jose` is installed transitively but absent from these emitted chunks. This measures the prototype's reachable imports with the default SDK validator, not a hypothetical minimal custom validator. The full dependency lists are in `bundle.cost` in the recording. No package or lockfile change was needed.

## Proposed ADR text for maintainer approval

No ADR file is changed by this spike.

**ADR-0006, integration/credentials:** Use call-scoped ChatOpenAI with a host-resolved credential and `maxRetries: 0` for remote calls. The host proxy permits the pinned SDK's observed request headers, including `x-stainless-helper-method` for JSON Schema parsing. CORS failures expose no HTTP status. Reconfirm the allowlist on SDK upgrades. Runtime policy owns retries; the proxy owns authoritative spending limits. Socket closure is not a billing guarantee.

**ADR-0011, implementation/profile:** Use MCP SDK Client/StreamableHTTPClientTransport behind a tools-only adapter, pinned to protocol 2025-11-25. Supply bounded streaming fetch, canonical parsed-result limits, finite request/idle timeouts and explicit rejection of unadvertised server requests. Replace a 404 session with a fresh initialized client; do not automatically repeat writes. Authenticate each request and bind sessions to the principal. Retain full-definition JCS pins and host approval; invalidating a session invalidates the prototype's approvals. Budget the measured SDK bundle cost and retest it on upgrades.

## Departures and limits

- The supplied file defines U1–U3, not U1–U6. Those three units were implemented in file order; no replacement plan was written.
- Node-executed TypeScript scripts use `.ts` specifiers with `allowImportingTsExtensions` because native Node cannot resolve a `.js` specifier to a `.ts` file. Browser source uses `.js` specifiers. Other strict flags are retained. Narrow assertions bridge the SDK's inconsistent optional transport declarations under `exactOptionalPropertyTypes`.
- The MCP prototype expands the plan's abbreviated hash fields and namespace to match Accepted ADR-0011, and adds fake authentication/principal binding and `authorization` to CORS for its mandatory profile.
- The page uses only host-authored status text and renders no model-produced props. React is not in the committed dependency set and was not added.
- A second Vite dev server serves the alternate origin instead of a preview/static server. Both use the same page; the alternate origin exercises a real SDK MCP connection.
- Ports are fixed to make the page CSP and recorded topology explicit. Occupied ports fail startup instead of selecting new ones.
- The default retry observation runs last so it cannot expire credentials used by earlier probes. Prefetch credentials are obtained immediately before each call. No retry timing is shortened or mocked.

**Not tested:** localhost/Ollama, Chrome Local Network Access prompt or denial, real providers, headed Chrome, any browser beyond headless Chromium, HTTP/2, the device matrix, OAuth, real account authorization, server-initiated elicitation/roots, reconnect replay, cancellation notifications, idle stream timeouts, real provider schema enforcement or billing. No claim about these follows from loopback HTTP fixtures.
