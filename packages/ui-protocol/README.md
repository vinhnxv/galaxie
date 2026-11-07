# @galaxie/ui-protocol

Pure A2UI v1.0 message parsing, catalog validation and atomic surface reduction.
The package has no dependencies and imports no galaxie package or platform service.
It shares the launch package version; the wire pin is independent of that version:
`1.0` at `dee8167996b0a802b18b3ebe51f3515c55b757de`.

## API

The public root exports:

- `parseMessage(value: unknown, extensions?: RegisteredExtensions): ParseResult`.
- `reduceBatch(previous: MaterializedSurface | undefined, messages: readonly unknown[], context: SurfaceContext): SurfaceResult`.
- `validateSurface(surface: unknown, context: SurfaceContext): SurfaceResult` for restore.
- `resolveDataPath(path: string, model: JsonObject, item?: JsonValue): JsonValue | undefined`,
  the pure lookup shared by validation and rendering. Absolute paths use the root;
  relative paths require a template item. Invalid or missing paths return `undefined`;
  lookup never traverses inherited properties and does not mutate data.
- `A2UI_SPEC_VERSION`, `A2UI_SPEC_REVISION`, `PROTOCOL_ERROR_CATEGORY` and the
  message, JSON, catalog, context, binding, surface and result types.

`SurfaceContext` requires `binding`, `catalog`, `limits: { payloadBytes, components }`
and `isAllowedUrl: (url: string) => boolean`. Optional `extensions` maps registered
extension names to synchronous schemas. No limits or URL policy are defaulted here.
The caller supplies the trusted `{ region, a2uiSurfaceId, catalogId }` binding;
messages can repeat identity but cannot change it. A catalog ID is an identifier,
never a resource to download.

```ts
import { reduceBatch, type Catalog } from '@galaxie/ui-protocol';

const catalog: Catalog = {
  id: 'example/v1',
  components: {
    Text: {
      bindable: ['text'],
      props: {
        '~standard': {
          version: 1,
          vendor: 'example',
          validate(value: unknown) {
            return value !== null && typeof value === 'object' &&
              Object.keys(value).length === 1 && 'text' in value &&
              typeof value.text === 'string'
              ? { value }
              : { issues: [] };
          },
        },
      },
    },
  },
};
const result = reduceBatch(undefined, [{
  version: '1.0',
  createSurface: {
    surfaceId: 'profile',
    components: [{ id: 'root', component: 'Text', text: { '@path': '/name' } }],
    dataModel: { name: 'Ada' },
  },
}], {
  binding: { region: 'main', a2uiSurfaceId: 'profile', catalogId: catalog.id },
  catalog,
  limits: { payloadBytes: 1_048_576, components: 50 },
  isAllowedUrl: () => false,
});
// result.ok narrows to result.surface; failures expose only code and optional index.
```

Catalog `props` and function `args` implement the structural `SyncSchema` contract
(Standard Schema v1, synchronous subset). Schemas must reject unknown properties.
Schema issues, thrown values and transformed outputs are discarded: validation does
not rewrite the wire representation. Schemas receive detached inputs, so a host
schema cannot mutate the candidate. Async results reject. Component schemas see
own properties excluding `id`, `component`, `catalogId`, `accessibility`, `metadata`.
The latter common fields are checked separately. `child` and `children` name
properties containing IDs and child lists; declare every reference this way.
`bindable` permits dynamic values; `urls` names literal URL attributes. A property
cannot be both. URL attributes also reject ASCII whitespace before the caller's
predicate. The caller remains responsible for scheme, origin and credential rules.

Functions declare `allowedCallers`, optional `requiresUserActivation` and an args
schema. Calls remain descriptors: this package never executes functions or checks
function results. A bindable property's schema must accept the registered function
call descriptor when it permits computation. `@index` is the only built-in system
function and is legal only in a template scope. An action `functionCall` is a
user-triggered call site; a renderer must still require a real gesture at invocation.
Events and function calls have strict common action shapes; the catalog schema owns
which properties are actions and their event names/context semantics.

## Reduction and validation order

All messages are parsed before applying anything. A batch operates on detached
copies in wire order. Creation applies data first and then component upserts.
Only the final candidate is returned; incomplete intermediate trees are allowed.
A successful nonempty batch advances the revision once, starting at 1, even for an
identical result or deletion. Deletion retains identity, pin and revision with empty
components/data; recreation continues the counter. Invalid lifecycle operations
reject. Safe-integer overflow rejects. Empty batches reject.

The deterministic precedence is:

1. Plain JSON/message shape, version, known unsupported features, then unknown
   message fields and extension schemas. Parsing failures carry the message index.
2. Trusted identity/catalog binding, then incoming batch UTF-8 JSON bytes.
3. Wire-order lifecycle and data-update operations on the candidate; malformed
   update paths fail at their operation. Stored-envelope shape/pins are checked
   before a previous record is used.
4. Materialized component count, then complete materialized record UTF-8 JSON bytes.
5. Catalog component schemas and property declarations, including literal-only URLs,
   common accessibility/metadata and non-bindable properties.
6. Graph integrity: root, duplicate IDs in message lists or child lists, resolved
   references, cycles (including disconnected ones), parent and child restrictions.
7. Reserved data keys and pointer syntax; resolve template targets as arrays.
8. Expanded template count: materialized definitions plus instantiated components
   and their descendants. Read each array's length before inspecting its items and
   stop at the cap. Shared ordinary graph nodes are visited once per template scope.
9. Resolve bindings in every rendered template item, then validate the substituted
   props with the catalog schema. Missing paths fail. Empty templates resolve
   absolute bindings and validate remaining relative descriptors as declarations;
   schemas for these props/arguments must accept that exact descriptor as well as
   resolved values. Unknown properties and function sites are still checked.
10. Function registration, caller, activation and argument checks, then URL policy.

Schema checks involving bindings necessarily follow graph/path resolution, and
expanded-count checks necessarily follow template-target resolution. These are the
exceptions to the general schema-before-graph/limits-before-schema order. Failures
from whole-candidate validation omit an index rather than attributing shared state
to one message. Extensions are validated while parsing and again on restore.

## Data update rules

Bindings use RFC 6901 pointers: `~0` is `~`, `~1` is `/`, and `''` means the root.
`/` in a binding addresses the empty-string key. Template-item relative paths omit
the initial slash and resolve within each item; absolute paths always use the root.
No lookup traverses inherited properties. Reserved `@` data keys reject at every depth.

For `updateDataModel`, omitted path, `''` or `/` replaces the root and requires a
plain object. A write creates missing intermediate **object** keys, which permits
the pinned `/user/name` example; it does not infer or extend arrays. Existing scalar
parents reject. Arrays accept only canonical decimal indices already in range;
no `-`, leading zeros, holes or append semantics. `null` deletes an object key or
splices an array item. Deleting an absent object key/parent is a no-op; an invalid
array index still rejects. A root `null` replacement rejects. Accepted no-ops still
advance the revision. Own `__proto__` keys stay inert own properties.

## Fixed failures

Every failure is `{ ok: false, code, index? }`, never message text, component data,
paths, values or schema issues. The category table is exhaustive at type and runtime.
Objects beyond the engine's copy/JSON traversal capacity reject as `INVALID_MESSAGE`;
no engine exception text is returned.

| Code | Category | Condition |
| --- | --- | --- |
| `INVALID_MESSAGE` | invalid | Non-JSON/invalid shape, multiple variants, empty batch or malformed stored record |
| `UNSUPPORTED_VERSION` | unsupported | Wrong wire version or stored spec pin |
| `UNSUPPORTED_RENDERER_MESSAGE` | unsupported | `callRendererFunction` |
| `UNSUPPORTED_AGENT_RESPONSE` | unsupported | `agentFunctionResponse` |
| `UNSUPPORTED_THEME` | invalid | Removed create theme |
| `DATA_MODEL_REQUIRED` | unsupported | Explicit false `sendDataModel`; omission means enabled |
| `UNKNOWN_FIELD` | invalid | Unknown message/common metadata field or unregistered/invalid extension |
| `BINDING_MISMATCH` | denied | Region, identity or catalog mismatch |
| `INTEGRITY_ERROR` | invalid | Invalid lifecycle, deletion marker or revision overflow |
| `DUPLICATE_COMPONENT_ID` | invalid | Duplicate ID in one component/child list |
| `UNKNOWN_COMPONENT` | unsupported | Component outside the bound catalog, including explicit Surface |
| `INVALID_COMPONENT_PROPERTY` | invalid | Unknown/invalid props, common action/accessibility fields or declarations |
| `MISSING_ROOT` | invalid | No live root |
| `UNRESOLVED_REFERENCE` | invalid | Missing referenced component |
| `CYCLIC_COMPONENTS` | invalid | Adjacency cycle anywhere |
| `UNALLOWED_PARENT` | invalid | Forbidden parent, including implicit Surface |
| `UNALLOWED_CHILD` | invalid | Forbidden child |
| `INVALID_DATA_PATH` | invalid | Invalid pointer/target, update parent or index |
| `RESERVED_DATA_KEY` | invalid | An `@`-prefixed data-model key |
| `URL_BINDING_FORBIDDEN` | denied | Dynamic URL property |
| `URL_NOT_ALLOWED` | denied | Nonliteral/whitespace URL or caller policy rejection |
| `PRIVATE_VALUE_IN_URL` | denied | Reserved for core's private-value URL scan |
| `PAYLOAD_TOO_LARGE` | budget_exceeded | Incoming batch or complete record above byte cap |
| `TOO_MANY_COMPONENTS` | budget_exceeded | Materialized/expanded components above cap |
| `UNKNOWN_FUNCTION` | unsupported | Unregistered function or out-of-scope `@index` |
| `FUNCTION_CALLER_DENIED` | denied | Agent-only function in component/action |
| `USER_ACTIVATION_REQUIRED` | denied | Invalid activation declaration or non-action activation call |
| `INVALID_FUNCTION_ARGUMENTS` | invalid | Arguments fail synchronous schema |
| `EXECUTION_ERROR` | invalid | Reserved for renderer execution; validator never emits it |
| `UNSUPPORTED_AGENT_FUNCTION` | unsupported | Deferred `callAgentFunction` |

`test/surface.test.ts` exercises every locally emitted code and checks the complete
table, including the two codes owned by core/renderer. Package tests are included in both
Node and Chromium lanes. Node-only tests check import boundaries and fixture attribution;
repository conformance tests cover real core URL rules, dependencies and packing.

## Scope and limits

This validator is not a security guarantee. It checks plain JSON, identity, catalog
schemas, graph/path integrity, caps, function call sites and declared literal URLs.
Catalogs and policy callbacks are trusted host code. Schemas must be strict and
synchronous. This package does not constrain arbitrary same-origin code or authorize
server operations. An origin policy does not constrain paths or query parameters.

Core consumes this package for pending surfaces; React consumes its public root
for catalog types and the shared data-path resolver. This React adoption is a
breaking change to the launch renderer surface API, intended for a 0.x minor
release under [the release policy](../../docs/releasing.md). Core owns labels
and private-value registration, `viewRevision`, whole-surface private-value URL
scanning and action data-model validation, and runs this validator before publication
and restore. A successful protocol result alone does not authorize publication or
checkpoint storage. Rendering, event dispatch, function execution/result validation,
real user activation and local input state are also outside this package.

## Upstream fixtures

`test/upstream-fixtures.ts` copies the four Column/Text protocol examples supplied
from the Apache-2.0 A2UI project at commit
`dee8167996b0a802b18b3ebe51f3515c55b757de`:
<https://github.com/a2ui-project/a2ui/blob/dee8167996b0a802b18b3ebe51f3515c55b757de/specification/v1_0/docs/a2ui_protocol.md>.
They are test vectors, not imported runtime code or a promise to implement the
entire upstream catalog. LICENSE and NOTICE are byte-identical to the repository
copies. No upstream runtime implementation is copied.
