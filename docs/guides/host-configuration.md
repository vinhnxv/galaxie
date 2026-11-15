# Host configuration

A host configuration document moves capability endpoints, model descriptors,
role routes and runtime limits into data. Agent definitions, graphs, workflows,
prompts and context stay in code. The format implements the proposal in
[ADR-0031](../adr/0031-declarative-host-configuration.md), which stays Proposed;
ADR-0012 guarantees are unchanged.

The worked example is [host-remote](../../examples/host-remote/README.md). Its
[galaxie.config.json](../../examples/host-remote/galaxie.config.json) replaces the
former TypeScript wiring for two HTTP capabilities, two model providers, two
roles and the quiz endpoint. It has no MCP servers or runtime limit overrides.

## Trust and authorship

The document has the same trust as host code. The host authors and serves it;
never accept it from end users, model output or tool results. Write access to the
file is write access to host wiring. An editor can change destinations, URLs,
credential modes, named hooks and limits within the validator's rules.

A bundled file is readable by every page visitor. It must contain no secret,
header value or function. Keep credentials and executable behavior in host hooks.
Bind those credentials to intended origins: validation cannot establish that a
document-chosen URL is the intended server, that the host controls an MCP server,
or that a backend authorizes requests. Reviewed agents and same-origin scripts
can bypass SDK paths. The [mandatory baseline](../adr/0012-security-baseline.md)
and [host integration obligations](host-integration.md) still apply.

## Parse, validate and build

The host loads and parses the document. Validation is pure: it invokes no hooks,
performs no I/O and creates no model, MCP server or runtime. It checks names
against one agent definition, resolves URLs and returns a detached, deeply frozen
snapshot of the document and hook records. Only the original validated result
can pass to the builders.

This flow assumes `text` is host-loaded JSON and `definition`, `hooks`, `appId`,
`executors`, `instanceOptions`, `services` and `feedback` come from trusted host
code. The definition declares the quiz provider's role and required capabilities;
the remaining instance options include the agent, principal, UI and confirmations.

```ts
import { createRuntime, GalaxieError } from '@galaxie-ai/core';
import {
  buildHostConfig,
  buildRuntimeLimits,
  validateHostConfig,
} from '@galaxie-ai/core/config';
import { openAICompatible } from '@galaxie-ai/models/openai';

const document = JSON.parse(text);
const validated = validateHostConfig(document, definition, hooks, location.origin);
const runtime = createRuntime({
  ...buildRuntimeLimits(validated),
  appId,
  executors,
});

// Build fresh options each time the host creates an instance.
const { bindings, modelRouting, endpoints } = buildHostConfig(validated);
const endpoint = endpoints['quiz'];
if (endpoint === undefined) throw new GalaxieError('invalid', 'The quiz endpoint is missing.');
const instance = await runtime.create(definition, {
  ...instanceOptions,
  bindings,
  models: modelRouting,
  services: {
    ...services,
    chatModels: { quiz: openAICompatible({ ...endpoint }), feedback },
  },
});
```

The example bundles its JSON with an import attribute instead of parsing text at
runtime. [host-config.ts](../../examples/host-remote/src/host-config.ts) owns the
document, definition validation and hook names; [runtime.ts](../../examples/host-remote/src/runtime.ts)
validates once and builds per instance. The endpoint entry contains `baseURL`,
`model` and `destination`; core returns these options without constructing a
provider. Routed calls still pass through the model router's policy and consent.
Direct model calls do not inherit those controls.

## Format reference

The [schema source](../../packages/core/src/config/schema.ts) defines the fields.
Objects are strict: an unknown key fails as `invalid`. `version` must be the
string `"0.1"`; another string version fails as `unsupported`. All sections below
are optional. A document does not replace required-binding checks at
`runtime.create` after composition.

Destination values are `in-browser`, `user-device`, `user-endpoint`, `host-server`
and `third-party`. They describe the final recipient, including any forwarding
by a proxy. Validation does not establish that a declared destination matches
the endpoint's actual recipient.

| Section | Fields and rules |
| --- | --- |
| `capabilities` | Map of names declared by the definition to HTTP bindings. Each entry requires `url`, `method`, `kind`, `destination`, `timeoutMs`, `concurrency`, `grantScope`, `approval` and `retry`. Optional `headers` and `fetch` name hooks; `credentials` is `omit`, `same-origin` or `include`; `propagateTraceContext` is a boolean. |
| `models` | Requires `providers` and `roles` maps. Optional `getCredential`, `consent`, `availability` and `download` name model hooks. |
| `models.providers` | Each provider requires `destination`, `modality` (`text` or `decision`), `features` and `pricing`. Features are `streaming`, `structured-output`, `tool-calling` and `cancellation`. Pricing is `"unknown"` or nonnegative `inputPerToken` and `outputPerToken`. Optional `languages` lists strings and `credential` is a boolean. |
| Provider `endpoint` | Optional OpenAI-compatible options: required `baseURL` and nonblank `model`, optional positive integer `maxTokens`, numeric `temperature` and named `fetch` hook. No headers or credentials appear here. |
| `models.roles` | Role names must be declared by the definition. Each route requires provider IDs in `providers`, destination classes in `allow` and nonnegative `maxTokens`. Optional `maxCost` is nonnegative and `repairAttempts` is a nonnegative integer. The existing router checks still apply. |
| `mcp.servers` | Map of server IDs to `url`, `destination`, named `token` hook and `tools`; optional named `fetch`, boolean `propagateTraceContext` and `limits` (`messageBytes`, `resultBytes`, `idleMs`). Tool entries require positive integer `version`, 64-character lowercase hex `pin`, `kind` (`read` or `write`) and the common policy fields; optional `result` is `structured` or `text`. |
| `limits` | Optional `budgets`, `dataPolicy` and `urlAllowlist`, built separately for the runtime. See [runtime limits](#runtime-limits). |

HTTP `method` is `GET`, `DELETE`, `POST`, `PUT` or `PATCH`. HTTP `timeoutMs` is a
positive number; MCP tool `timeoutMs` must be a positive safe integer. Common
policies use positive integer `concurrency`, `grantScope` of `app`,
`principal`, `instance` or `run`, `approval` of `none` or `confirm`, and `retry`
of `none`, `idempotent` or `idempotency-key`. HTTP `kind` can be `read`, `write`,
`device` or `ui`; MCP restricts it to `read` or `write`. MCP writes require
`confirm`. Host-rendered confirmations remain necessary for dispatch.

HTTP placeholders must name declared input fields; path placeholders cannot be
free text. HTTP destinations cannot be `in-browser`, and `user-device` requires
loopback. Trace propagation is opt-in and requires `host-server`. See the
[core binding documentation](../../packages/core/README.md) for transport and
broker controls.

## Named hooks

The host supplies a `HostConfigHooks` record. A document string selects a function
from the corresponding group; unknown names fail validation. Validation snapshots
the records without invoking the functions.

| Hook group | Host function |
| --- | --- |
| `headers` | HTTP capability headers from the call's `CapabilityContext`. |
| `fetch` | Fetch implementation for a capability, model endpoint or MCP server. |
| `token` | MCP token callback receiving `principalScope` and `signal`. |
| `getCredential` | Model credential callback used by routing. |
| `consent` | Model consent hook. |
| `availability` | Model availability hook. |
| `download` | Model preparation/download hook. |

Host-remote maps its functions to these names:

```ts
const hooks = {
  headers: { session: headers },
  getCredential: { 'model-proxy': getCredential },
  consent: { 'quiz-consent': consent },
};
```

Its headers hook returns the renewable capability bearer token. Its model
credential hook awaits session renewal and returns a fixed page placeholder;
the same-origin proxy authenticates the separate HttpOnly cookie and substitutes
the server-only key. Consent and browser feedback stay in host code. The
[example README](../../examples/host-remote/README.md) records the cookie, token,
same-origin script and backend limits.

## Origin-relative URLs

Capability URLs, model endpoint base URLs and MCP URLs starting with one `/`
resolve against the supplied base origin. A base URL path is ignored:
`/api/v1` with base `https://app.example/school/` becomes
`https://app.example/api/v1`. Template braces are preserved for HTTP capabilities.

`//` prefixes, backslashes (including `/\`), whitespace, URL userinfo and unrooted
relative URLs fail. Resolved URLs still pass destination and protocol checks:
HTTPS is required except HTTP on loopback (`localhost`, `127.0.0.1`, `[::1]`).
Model endpoints and MCP URLs reject queries and fragments, `in-browser`, and
non-loopback `user-device` destinations. These checks do not identify the intended
server or authorize a request.

## Editor schema and CI validation

The build generates draft 2020-12 JSON Schema at
`packages/core/dist/config/host-config.schema.json`, exported as
`@galaxie-ai/core/host-config.schema.json`. No hand-maintained schema copy is
needed. For an installed core package, a VS Code `settings.json` mapping can use
the generated file:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["/galaxie.config.json"],
      "url": "./node_modules/@galaxie-ai/core/dist/config/host-config.schema.json"
    }
  ]
}
```

Adjust the physical path for the host workspace; the package export can be
located with `import.meta.resolve('@galaxie-ai/core/host-config.schema.json')`.
Do not add `$schema` to the document: it is an unknown key in the strict format.
The editor schema checks shape only. Definition names, hook resolution, URLs and
destinations require `validateHostConfig`.

Run full validation in CI against the actual definition with stub host hooks.
Host-remote's [parity test](../../examples/host-remote/test/config-parity.node.test.ts)
uses its production document and hook mapping, checks undeclared capabilities and
unknown hooks against fixed error paths, and runs without built `dist` files:

```sh
pnpm exec vitest run --project node examples/host-remote/test/config-parity.node.test.ts
```

## Runtime limits

`buildRuntimeLimits(validated)` returns `budgets`, `dataPolicy` and `urlAllowlist`
for `createRuntime`. If several documents share one runtime, take these options
from exactly one document, without merging them. They apply to every instance
on that runtime. With no `limits` section, as in host-remote, the builder returns
`{}` and existing runtime defaults apply.

Budget keys are `steps`, `tokens`, `cost`, `repairAttempts`, `toolCalls`,
`wallClockMs`, `payloadBytes` and `uiElements`. `steps` is a positive integer;
token, repair, tool-call, payload and UI counts are nonnegative integers; cost and
wall-clock limits are nonnegative numbers. `dataPolicy` maps `public`, `app` and
`private-user` to `{ "allow": [destination] }` lists. `urlAllowlist` lists allowed
origins. The runtime retains its own validation and enforcement.

## MCP composition

`@galaxie-ai/tools-mcp` is private, unpublished and workspace-only. Its
`buildMcpServers` composes the validated MCP section with core's HTTP builder:

```ts
import { buildHostConfig } from '@galaxie-ai/core/config';
import { buildMcpServers } from '@galaxie-ai/tools-mcp';

const mcp = buildMcpServers(validated);
const host = buildHostConfig(validated, mcp.bindings);
// Pass host.bindings and host.modelRouting to runtime.create.
// On sign-out, disconnect this principal locally.
await Promise.all(Object.values(mcp.servers).map((server) => server.closePrincipal(principalScope)));
// On shutdown, close every host-owned client.
await Promise.all(Object.values(mcp.servers).map((server) => server.close()));
```

Derived names are `mcp.<server>.<tool>@<version>` and must be declared by the
definition. HTTP capability names cannot start with `mcp.`; duplicate names in
document and code bindings fail. The builder performs no I/O or hook invocation.
Factory checks still run; construction failure closes servers already created
and reports the server or tool path. The host owns lifecycle; local close does
not terminate the remote session. Pins detect metadata changes, not behavior
changes behind unchanged metadata. See the [MCP guide in the package README](../../packages/tools-mcp/README.md#build-from-a-host-configuration)
for limits and obligations. Host-remote adds no MCP wiring.

## Configuration errors

`HostConfigError` retains a fixed message, `code` and a JSON Pointer `path` to the
entry, without document values such as URLs, header names or secrets in the
message. The path can contain document key names. Show it only to the
configuration editor and handle it at the document's trust level, never as an
end-user error. HTTP factory/descriptor failures may retain a fixed-message
`GalaxieError` cause; raw host and Zod errors are not retained.

## YAML input

If a host chooses YAML, it parses it before calling `validateHostConfig`.
No galaxie package parses YAML, and this example adds no YAML parser. The same
plain-data shape and trust rule apply after parsing.

## Delivery

Bundling is the default and host-remote's choice. The SDK loads no configuration
by URL or from storage. Runtime fetching by the host remains an open maintainer
review question in ADR-0031, along with its delivery and write-access requirements.
This guide establishes no runtime-fetch pattern and does not mark the ADR Accepted.
