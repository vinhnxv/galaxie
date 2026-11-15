# ADR-0031: Declarative host configuration for agent wiring

- **Status:** Proposed
- **Date:** 2026-11-15
- **Related:** brief §0.2, §1.1, §5.2, §9.7, §13.2; ADR-0002, ADR-0006, ADR-0008, ADR-0011, ADR-0012, ADR-0017
- **Revisions:**
  - 2026-11-15: initial proposal.
  - 2026-11-15: core configuration subpath implemented and verified with mock unit/Node conformance tests, schema, pack, dependency and size gates. Status stays Proposed pending maintainer review.
  - 2026-11-15: tools-mcp builder implemented with mock failure tests and loopback fake-endpoint integration, parity and local lifecycle tests. Host-remote adoption and the guide remain planned; status stays Proposed.

## Context

The host currently wires agents in TypeScript. [host-remote](../../examples/host-remote/src/runtime.ts) constructs one GET and one POST `httpCapability` with a shared policy, two model providers and two role routes, and an `openAICompatible` quiz endpoint at `/api/v1`. Its headers, credential callback and consent hook are host code. Changing this wiring requires a code edit.

The core host configuration document API now implements the validation and HTTP/routing half of this proposal. A console or deployment pipeline would need a plain-data representation of wiring without duplicating the agent definition or carrying executable code. The [brief](../galaxie-project-brief.md) leaves the console's scope open (§20, question 5); this proposal does not settle it.

[ADR-0008](0008-code-first-agent-definition.md) rejects YAML agent definitions because two hand-maintained descriptions drift and lose type checking. [ADR-0011](0011-mcp-via-controlled-servers.md) requires MCP servers configured in host code, and [ADR-0012](0012-security-baseline.md) sets the mandatory controls and host obligations. A data format for wiring needs an explicit boundary against those decisions before implementation.

## Decision

Propose a versioned plain-data host configuration document for one agent definition, with validation and building in `@galaxie-ai/core/config`. `buildMcpServers` in `@galaxie-ai/tools-mcp` now builds MCP servers and pinned bindings from the validated configuration. Core does not import models or tools-mcp; the host composes them under the existing [dependency rules](../system-design.md#4-packages-and-dependency-rules). The core subpath implements the document schema, pure validation and HTTP/routing/runtime-limit builders. Host-remote adoption and the guide remain planned. This ADR stays Proposed; ADR-0012 guarantees are unchanged.

The proposed contract is:

1. **Wiring only.** The document would describe HTTP capability endpoints, model providers and role routes, OpenAI-compatible endpoints, MCP servers with pinned tools, and runtime limits. It would never define an agent, graph, workflow, prompt or context. Those would stay in code. Per-user configuration and a web console are out of scope.
2. **Host-owned parsing and loading.** The host would read and parse JSON or YAML and pass an already parsed object. The proposed galaxie configuration API would parse no YAML, load nothing by URL or from storage, and neither fetch nor follow redirects to a configuration URL. No published galaxie package would contain a YAML parser. Bundling the document with the host is the proposed default; runtime fetching by the host remains an open review question below.
3. **Named hooks, no inline authority.** The document would contain no credential, header value or function. Headers, fetch, token, credential, consent, availability and download hooks would stay in host code and be named in the document by string. Validation would resolve those names against host-supplied hooks without invoking them; an unknown name would fail.
4. **Definition-bound names.** Every capability and model role named by the document would have to be declared by the agent definition. Derived MCP capability names, `mcp.<server>.<tool>@<version>`, would also have to be declared there. Any undeclared name would fail validation. Provider identifiers would remain host wiring, referenced by the declared roles' routes.
5. **Validate, then build.** Validation would be pure, with no side effects and no server, model or runtime creation. It could construct and discard HTTP binding objects to run the existing descriptor checks. Only a validated configuration could proceed to building. An unknown document version would fail as `unsupported`; unknown keys would fail as `invalid`.
6. **Resolve URLs before factories.** Capability URLs, endpoint base URLs and MCP URLs that begin with a single `/` would be resolved against a host-supplied base URL before any factory sees them, and resolution must keep the base origin: `//` and `/\` prefixes are not origin-relative and would fail. The resolved URLs would still have to pass their destination and protocol checks.
7. **Apply the HTTP destination rule to model endpoints.** The proposed configuration layer would reject endpoint destination `in-browser`, reject `user-device` on a non-loopback host, and require HTTPS except for HTTP on loopback. Loopback means `localhost`, `127.0.0.1` or `[::1]`, as in [core's URL checks](../../packages/core/src/urls.ts). This would add a destination check to the configuration path: today's private `validateOptions` in [the model constructor](../../packages/models/src/openai/chat-model.ts) checks HTTPS or loopback HTTP, forbids URL credentials, query and fragment, and rejects `authorization`, `cookie` and `host` headers, but accepts all five destination classes without checking host class. The proposal would retain those existing URL and header restrictions too. How an endpoint's destination relates to a role's `allow` list is left to the implementing issue, and endpoint headers stay out of the document (rule 3).
8. **Value-free errors with entry paths.** Configuration errors would identify the offending document entry by JSON Pointer, preserve the original error code, and never contain document values.
9. **Runtime limits built separately.** Budgets, data policy and the URL allowlist currently belong to [RuntimeOptions](../../packages/core/src/runtime.ts) and apply to every agent on that runtime. The proposed configuration API would build those options separately from instance bindings and routing. A host with several documents on one runtime would take its runtime limits from exactly one document, without merging them.
10. **Host-authored, host-served trust.** The document would be authored and served by the host, with the same trust as host code. It would never come from end users, model output or tool results. Write access to it would be treated as write access to host wiring.

ADR-0031 narrows ADR-0008's YAML rejection to agent definitions; it does not reverse it. The proposed wiring document would not duplicate the definition: validation would check capability, role and derived MCP tool names against it, while closures would remain in host code, consistent with ADR-0008's `create(host)` boundary. This gives up the compiler check available to code-defined wiring in exchange for validation against the definition; hosts adopting the document should run that validation in CI, while hosts keeping wiring in code retain the compiler check.

The proposed document would grant no power beyond existing host options. HTTP capabilities would still be built through [httpCapability](../../packages/core/src/http-capability.ts), with its destination checks and the [broker's descriptor checks](../../packages/core/src/capability-broker.ts) unchanged: placeholders must name declared input fields, and path placeholders cannot be free text. The existing `runtime.create` checks would remain in place after building.

The configuration validator applies equivalent checks for model endpoints and MCP servers, rather than reusing every factory validator. The model validator is private to `@galaxie-ai/models`; [createMcpServer](../../packages/tools-mcp/src/server.ts) requires a token function and validates server IDs, URLs and destinations, while its bindings require 64-hex tool pins and confirmation for writes. Their construction-time checks still run during building. MCP construction belongs only to the tools-mcp builder, preserving the dependency direction toward core. Duplicating rules can drift; parity tests compare validation and the existing constructors. Core currently accepts fractional tool timeouts that `bindings()` refuses; the builder retains that refusal with the tool's JSON Pointer.

For MCP, the proposal fits ADR-0011 only if a host-authored document under the trust rule above counts as "configured in host code". It does not amend ADR-0011, and acceptance needs the maintainer to confirm that reading, possibly with a clarifying ADR-0011 change separately. Agents would gain no ability to add servers. Pins would be data, not credentials; a pin would be only as strong as write access to the document. ADR-0011's metadata-change detection would remain unchanged, including its inability to detect changed behavior behind unchanged metadata.

## Alternatives considered

- **YAML agent definitions.** Rejected for the reasons in ADR-0008's Context and Consequences: duplicated definitions drift and lose compiler checking, and closures belong in `create(host)`. ADR-0017 also keeps agent authoring with existing frameworks rather than adding a graph DSL. This proposal covers wiring only.
- **galaxie-side YAML parsing.** Rejected: it would add a parser dependency and its supply-chain surface to published configuration code and invite format-specific behavior. Existing factories accept JavaScript options, so the host can parse JSON or YAML before validation; the dependency direction in system design §4 gives core no role in document delivery.
- **Inline secrets.** Rejected: ADR-0012 A4 and B3 and brief §9.7 keep credentials out of agent data and provider keys out of bundles. The document could be bundled and inspected. Credentials would stay behind host hooks, following the existing [host credential pattern](../guides/host-integration.md#credentials-for-apis-mcp-and-remote-models).
- **Config by URL as a galaxie API.** Rejected: it would couple wiring to network delivery and CSP instead of pure validation. ADR-0002 forbids runtime code loading; this proposal would also leave data-document delivery with the host, without treating that ADR as an existing ban on fetching data. The planned example would bundle the document by default; whether to allow a host runtime-fetch pattern remains open for review.

## Consequences

If implemented, hosts could change URLs or model choices without editing TypeScript wiring. Agent definitions, prompts, context, credentials and functions would stay in code. A document would not establish that an endpoint implements a claimed model feature or that a backend authorizes requests.

No ADR-0012 item is changed, relaxed or excepted. The proposed translation would preserve the existing SDK-controlled paths and their documented limits:

- **A1-A3:** URL/UI policy, deny-by-default capability and schema checks, and the absence of generic fetch, SQL or shell capabilities would remain on their current paths. A document could name only capabilities the definition declares.
- **A4:** host credential callbacks and allowlisted trace recording would remain unchanged; the document would supply hook names rather than credentials or header values.
- **A5-A6:** host-rendered, parameter-bound single-use approvals, destination notices and consent, and data-label enforcement would still run in the existing gate and router.
- **A7-A8:** runtime budget validation would retain finite defaults; HTTP attribution headers and MCP call attribution would stay on the existing transport paths and would never authorize a request.
- **A9-A10:** MCP pin checking, and logout invalidation, principal-data wiping and in-flight result/approval invalidation would remain unchanged. The document would not replace any of those controls; editing a pin in the document is itself the approval act and carries the trust and delivery questions of any document write.

Whoever could edit the document could change URLs, destinations, model choices, the URL allowlist, data policy and budgets within what validation accepts. Credential and token hooks in host code would then run against document-chosen URLs. The host would still have to bind credentials to the intended origins and scope tokens; validation could not show that a URL is the intended server or establish server-side authorization (ADR-0012 B1). MCP servers controlled by the host would remain a host obligation (B6), not something URL validation can enforce. B3's ban on bundled provider keys and tracing credentials and B10's scoped, short-lived write-token obligation would remain unchanged.

A runtime fetch, or a console or deployment pipeline that writes the document, would sit outside B7's assumption of bundled, reviewed code. This proposal grants no exception to B7 or ADR-0002: reviewed, bundled agents would remain required. Bundling the wiring document is the proposed default, and the delivery and write-access implications would need maintainer review before another pattern is adopted.

Two questions remain open for that review:

1. Does ADR-0011's "configured in host code" cover this host-authored data document under the proposed trust rule, or is a separate clarification needed?
2. Should the document stay bundled, or may the host fetch it at runtime, and what review and delivery requirements would that need?

Status stays Proposed until the maintainer reviews it.

## Verification

The core implementation is covered by `packages/core/test/config.test.ts` and
`tests/conformance/host-config.node.test.ts`: immutable validation without hook
invocation, fixed error codes and JSON Pointers, HTTP policy parity, destination
and URL checks, runtime limits and approval-gated tutor calls through injected
fetch. A stricter definition rejects config-built descriptors at `runtime.create`.
Node conformance also records the intended capability-userinfo and endpoint
destination differences from today's factories, and that validation refuses the
MCP server shapes `createMcpServer` refuses (destination, query, fragment, userinfo,
trace-propagation destination and limits).

`pnpm check` verifies the generated draft 2020-12 JSON Schema, package exports,
dependency boundaries and own-code size budgets; the main-entry budget is
unchanged. `pnpm run check:docs` checks Markdown links and heading anchors, not
ADR status. The [index](README.md#index) still lists Proposed.

`packages/tools-mcp/test/config.test.ts` compares document-built MCP names and
policies against hand-built bindings and runtime calls against a loopback fake
endpoint. It covers principal token routing, no build-time hook invocation or I/O,
forged objects, own-property hooks, server/tool error paths and causes, rollback,
text results, limits, trace propagation, events and host-owned local close.
Mock failures exercise factory rejections that core validation normally prevents.
The dependency conformance tests include an old-script negative control for the
builder-only core/config import exception. Node and Chromium MCP conformance load
the tools-mcp root export, including the configuration module.

Host-remote adoption, its parity run and the guide remain planned. `check:deps`
continues to forbid YAML parsers in published packages.

Unmeasured: real hosts, browser configuration integration, consumer-bundle size
with Zod in tools-mcp's module graph, real MCP servers and real backends. The
document's host-authorship and trust rule, intended-server identity, credential
scope and backend authorization remain host obligations that galaxie cannot
establish through document validation.
