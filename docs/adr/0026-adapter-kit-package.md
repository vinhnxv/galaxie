# ADR-0026: Shared adapter helpers in a non-adapter package

- **Status:** Proposed
- **Date:** 2026-11-07
- **Related:** brief §7.6, §14.2; system design §4; ADR-0012, ADR-0017, ADR-0018, ADR-0020, ADR-0023

## Context

System design §4, rule 2 says: "Packages do not import each other; the host app wires them together through `createRuntime` (brief §14.2)." Integration packages depend on core and their own libraries. Adapters cannot import one another. Consequently, the LangGraph.js, Pyodide, ADK JavaScript and Go adapters carry copies of common adapter logic. Core owns framework-neutral policy; these copies translate its ports into model and bridge operations.

`scripts/check-dependencies.ts` has explicit import allowlists for Pyodide, ADK JavaScript and Go. The latter two reject `@galaxie/adapter-*` imports and relative paths into sibling adapter directories. LangGraph's dedicated check currently restricts LangGraph imports to `@langchain/langgraph/web`; it does not enforce the full adapter-to-adapter prohibition. The extraction must close that enforcement gap, rather than treating it as permission to share through LangGraph.

### Verified duplication and extraction baselines

The inventory below names source symbols, not every caller of a helper. All five requested categories have at least two real copies; none is dropped. Similar responsibilities do not imply identical contracts. Where validation differs by dimension, there is no single strictest implementation: the baseline is named for each shared operation, and adapter-specific checks remain in place.

#### Tool-call text extraction

| Site | Duplicated operation |
| --- | --- |
| `packages/adapter-langgraph/src/routed-chat-model.ts`: `rawArgumentChunks`, `argumentChunks`, `outputText` | Read normalized and invalid calls plus raw `additional_kwargs.tool_calls`; normalize parsable argument JSON, remove raw mirrors of normalized calls, and join text and argument strings. |
| `packages/adapter-pyodide/src/tool-calls.ts`: `rawArgumentChunks`, `argumentChunks`, `outputText` | The same extraction and mirror removal; `argumentChunks` also has an `includeRaw` switch for executable calls. |
| `packages/adapter-adk/src/tool-calls.ts`: `rawArgumentChunks`, `replyCalls`, `outputText` | The same extraction and mirror removal, returning `ReplyCall` records. |
| `packages/adapter-go/src/tool-calls.ts`: `rawArgumentChunks`, `replyCalls`, `outputText` | The same extraction and mirror removal as ADK JavaScript. |
| `packages/adapter-langgraph/src/routed-chat-model.ts`: `RoutedChatModel._streamResponseChunks`; `packages/adapter-pyodide/src/tool-calls.ts`: `fragmentsOf`, `GrowingOutput` | Accumulate text and raw argument fragments without losing complete calls or unmirrored raw arguments when native concatenation drops them. Their fragment-slot rules differ. |
| `packages/adapter-adk/src/llm.ts`: `GalaxieLlm.#stream`, `sameJson`; `packages/adapter-go/src/stream.ts`: `StreamJoiner.append`, `StreamJoiner.finish`, `sameJson` | Group fragments by index, ID or position, compare the joined call arguments with the original JSON, and refuse truncated JSON or a mixture of complete calls and fragments. Go obtains fragments through `packages/adapter-go/src/tool-calls.ts`: `fragmentsOf`. |

**Strictest baselines:** LangGraph's `plainObject` guard in `rawArgumentChunks` rejects non-plain raw call/function objects; the other three raw readers only reject null, non-objects and arrays. Start the common raw reader there. ADK JavaScript's `#stream` and Go's `StreamJoiner` tie on rejecting repaired/truncated arguments and mixed complete/fragment streams. Pyodide's `GrowingOutput` additionally retains growing IDs and names and aliases index/ID slots; LangGraph separately preserves unmirrored raw arguments. Extract only the common bookkeeping, retaining each stream's existing checks, grouping and acceptance rules.

The shared fixture is `tests/conformance/support/tool-call-checks.ts`: `toolCallChecks`. Its text, multiple-call, invalid-argument, raw-argument and raw-mirror cases are consumed by `packages/adapter-langgraph/test/output-safety.test.ts`, `packages/adapter-pyodide/test/tool-calls.test.ts`, `packages/adapter-adk/test/tool-calls.test.ts` and `packages/adapter-go/test/stream.test.ts`.

The final checks and executable-call conversion are intentionally distinct. `packages/adapter-adk/src/tool-calls.ts`: `checkedText` appends IDs and names. `packages/adapter-pyodide/src/tool-calls.ts`: `toolCalls` uses `validToolCall` and excludes raw mirrors from executable calls; `createPyodideAdapter` checks growing IDs/names and final returned IDs. `packages/adapter-go/src/llm.ts`: `callsOf` rejects invalid calls, unoffered names and missing/oversized IDs; `serveModel` checks the raw payload, argument strings, IDs and names. `packages/adapter-adk/src/llm.ts`: `GalaxieLlm.#generate` rejects invalid/unoffered calls and replaces provider IDs with run-owned IDs. These framework mappings and extra checks stay at their callers; identical shared `outputText` does not mean identical final hook input or executable calls. Go's `growingText` also includes unparsed fragments before a call can be constructed.

#### Routed provider and credential resolution

| Site | Duplicated operation |
| --- | --- |
| `packages/adapter-langgraph/src/routed-chat-model.ts`: `RoutedChatModel.#begin` | Resolve the lease's provider ID using an own-property lookup; reject a missing implementation or a credential factory without a credential; construct that factory for this call. |
| `packages/adapter-pyodide/src/adapter.ts`: model-request branch inside `createPyodideAdapter` | The same provider lookup, credential check and per-call factory construction. |
| `packages/adapter-adk/src/llm.ts`: `GalaxieLlm.#bind` | The same provider lookup, credential check and per-call factory construction. |
| `packages/adapter-go/src/llm.ts`: `serveModel` | The same provider lookup, credential check and per-call factory construction. |

**Strictest baseline:** all four tie on this operation: inherited provider entries are unavailable, missing credentials for factories are invalid, and credentials enter only the factory argument. LangGraph's `#begin` additionally detects the unimplemented `BaseChatModel.prototype.bindTools`; that runtime/framework check stays in LangGraph. Core's model router still selects the route and obtains ephemeral credentials through the host. The kit only resolves an already-selected lease; it introduces no credential store, provider fallback or routing policy. Credentials must still stay out of model options, callbacks, bridge frames, state and traces.

Prepare also duplicates the provider-descriptor/factory agreement check in `packages/adapter-langgraph/src/host.ts`: `createHost`, `packages/adapter-adk/src/host.ts`: `createHost`, `packages/adapter-pyodide/src/adapter.ts`: `validServices`, and `packages/adapter-go/src/llm.ts`: `validServices`. All use own properties and require the factory form exactly when `descriptor.credential` is true. The LangGraph and ADK host copies also share the fixed invalid-implementation message.

#### Prepare-time service validation

| Site | Duplicated operation |
| --- | --- |
| `packages/adapter-langgraph/src/host.ts`: `validServices` | Require an object with a non-array `chatModels` record whose entries are factories or objects with callable `invoke`; optionally validate the LangGraph saver methods. |
| `packages/adapter-pyodide/src/adapter.ts`: `validServices` | Validate the same model record, the optional byte-record port's `request`, and preparation provider descriptors. |
| `packages/adapter-adk/src/host.ts`: `validServices` | Validate the same model record and optional byte-record port's `request`; `createHost` checks provider descriptors. |
| `packages/adapter-go/src/llm.ts`: `validServices`; `packages/adapter-go/src/checkpoints.ts`: `validCheckpointPort` | Validate the same model record, optional byte-record port and preparation provider descriptors. |

**Strictest baseline:** Pyodide rejects arrays as the services object, a model implementation object and the checkpoint port, and checks descriptors before fetching sources or constructing a Worker. Go matches the shared model-record/descriptor checks, but `validCheckpointPort` only checks object/non-null/callable `request`. The LangGraph and ADK service guards allow object-shaped arrays in some of those positions. Start shared record/model/port checks from Pyodide, preserving the LangGraph saver's distinct `getTuple`, `list`, `put` and `putWrites` contract in LangGraph. Adapter-specific default services and prepare ordering stay local.

Evidence includes `packages/adapter-langgraph/test/routing-services.test.ts`, `packages/adapter-pyodide/test/adapter.test.ts` (validation before fetch/Worker creation), and `packages/adapter-adk/test/host.test.ts` (model/factory and descriptor agreement).

#### Error helpers

| Sites | Duplicated operation and baseline |
| --- | --- |
| `packages/adapter-langgraph/src/errors.ts`: `adapterError`; `packages/adapter-adk/src/errors.ts`: `adapterError` | Identical fixed `toErrorInfo` result on a `GalaxieError`, with the original cause non-enumerable. Tied baseline; preserve diagnostic cause handling. |
| `packages/adapter-langgraph/src/routed-chat-model.ts`: `failure`; `packages/adapter-adk/src/errors.ts`: `failure`; `packages/adapter-pyodide/src/errors.ts`: `adapterFailure`; `packages/adapter-go/src/errors.ts`: `adapterFailure` | Construct `GalaxieError` with core's fixed message for the code. Tied content-free baseline; LangGraph's wrapper accepts fewer codes. The repeated construction also appears inline in `packages/adapter-langgraph/src/host.ts`: `createHost` and `packages/adapter-langgraph/src/adapter.ts`: `createLangGraphAdapter`'s capability callback. |
| `packages/adapter-pyodide/src/errors.ts`: `failureCode`; `packages/adapter-adk/src/run.ts`: `toGalaxieError`; `packages/adapter-go/src/checkpoints.ts`: `storageCode`, `unavailable` | Recognize `invalidated`, `fenced` and `unrecoverable` storage markers as `stale`, `fenced` and `unrecoverable`. Pyodide's marker-first mapping is the baseline for marker recognition; ADK and Go preserve an existing galaxie error first. Preserve that caller-specific precedence. |
| `packages/adapter-pyodide/src/errors.ts`: `failureCode`; `packages/adapter-go/src/adapter.ts`: `failureCode`; `packages/adapter-adk/src/run.ts`: `toGalaxieError` | Preserve recognized galaxie codes and otherwise use a fixed fallback. Pyodide additionally recognizes `BridgeValidationError`; ADK recognizes aborts and ADK integrity errors through a bounded cause walk. Those extra classifications stay with their framework/bridge wrappers. |
| `packages/adapter-pyodide/src/bridge.ts`: `codes`, `valid`; `packages/adapter-go/src/errors.ts`: `CODES`, `errorCodeOf` | The same closed set of allowed galaxie error codes. Pyodide rejects unknown bridge error codes; Go maps unknown program codes to `executor_error`. Start from the closed set and preserve both boundary behaviors. |

There is no total ordering for throwable classification: the strictness is in recognized markers, fixed messages and closed wire codes, not replacing one framework's error semantics with another's. LangGraph recursion/interrupt mapping and credential-failure cause filtering in `packages/adapter-langgraph/src/adapter.ts`: `createLangGraphAdapter` remain adapter-owned. Existing private-detail refusal tests in `packages/adapter-pyodide/test/adapter.test.ts` and unknown-code tests in `packages/adapter-go/test/adk-go.node.test.ts` are preservation evidence.

#### Worker bridge framing and validators

| Sites | Duplicated operation |
| --- | --- |
| `packages/adapter-pyodide/src/bridge.ts`: `MAX_BRIDGE_BYTES`, `parseBridge`, `encodeBridge`, `valid`, `keys`, `json` | JSON text framing, a 1,048,576-byte UTF-8 bound, closed envelopes and recursively checked JSON values. |
| `packages/adapter-go/src/protocol.ts`: `MAX_BRIDGE_BYTES`, `withinBridgeLimit`, `encodeHostMessage`, `parseHostMessage`, `encodeWorkerMessage`, `parseWorkerMessage`; `packages/adapter-go/src/bridge.ts`: `parseFrame`, `encodeReply`, `keys`, `plain` | The same byte bound, JSON serialization/parsing, closed envelopes/payloads and recursive finite/cycle-free JSON checks. |
| `packages/adapter-pyodide/src/bridge.ts`: `modelMessage`, `toolDefinition`, `validToolCall`, model/capability branches of `requestPayload`; `packages/adapter-go/src/bridge.ts`: `validMessage`, `validTool`, `validToolCall`, `parseModelPayload`, `parseCapabilityPayload` | Validate the overlapping chat roles, function tools, tool calls, model options and capability requests. |

**Strictest baselines:** Pyodide's `encodeBridge` validates the complete outgoing envelope and JSON before encoding; Go's protocol encoders stringify typed messages, and its receive parsers bound selected string fields. Use Pyodide's validated framing as the extraction starting point, keeping Go's existing field boundaries and wire format. Both reject unknown fields. Pyodide's `json` also refuses non-plain object prototypes; Go's `plain` adds a depth limit of 64. Neither dominates: retain both protections wherever they already apply, without imposing a new wire schema. Go constrains run/call IDs and function names more tightly; those schema-specific rules stay in the Go validators. The same applies to Pyodide's checkpoint, wheel, Python-module and notification validators.

The envelopes are different protocols: Pyodide uses `galaxie.bridge/v2` with request/response/notify operations; Go uses `v: 1` with boot/run/cancel/reply and ready/call/done/exit messages. Share pure framing and overlapping validation primitives, not one replacement envelope. Go's `parseBoot`, `encodeBoot` and WASM/build validators remain Go-specific. ADK JavaScript runs in the page and has no Worker bridge copy; its request conversion and stored-session validators are not another bridge implementation. The existing malformed-frame evidence is in `packages/adapter-pyodide/test/bridge.test.ts` and `packages/adapter-go/test/bridge.test.ts`.

### Other candidates, outside this extraction

- **Stored-record codecs:** `packages/adapter-adk/src/persist.ts`: `plain`, `only`, `parse`, `base64`, `jsonBytes`; `packages/adapter-go/src/persist.ts`: `plain`, `only`, `parse`, `base64`, `recordBytes`. These share small JSON/byte utilities, but stored schemas, integrity metadata and restore checks remain adapter-specific. Persistence extraction is outside this decision.
- **Lease settlement:** `packages/adapter-langgraph/src/routed-chat-model.ts`: `finish`, `packages/adapter-pyodide/src/adapter.ts`: `finish`, and `packages/adapter-go/src/llm.ts`: `finish` all prevent double settlement; ADK's `GalaxieLlm.#generate` has the same settled/finally pattern. Their run bookkeeping, tracing and draining belong to executor lifecycle and are outside this extraction.

## Decision

Create `@galaxie/adapter-kit` in `packages/adapter-kit` as a **non-adapter package** for the five verified categories above, restricted to their common parts. It registers no executor. Adapters may depend on it and must still never import one another. No package or code moves with this Proposed record; today's enforced dependency rules remain in force until extraction lands.

### Import and publication contract

The kit's production source and build have exactly this import/re-export allowlist:

- `@galaxie/core`, through its public root exports only, for values and types; no deep imports or relative access to core internals.
- `@langchain/core` and `@langchain/core/*`, **erased type-only references only** (`import type`, `export type` or import types). No value imports, side-effect imports or dynamic runtime imports from LangChain.
- Relative files resolving inside `packages/adapter-kit`; no relative escape into another package or `node_modules`.

It imports no adapter, framework runtime, Pyodide, Go/WASM glue, model implementation, UI framework or Node-only module. LangChain runtime predicates (`isAIMessage`, `isAIMessageChunk`), message construction, native concatenation and `BaseChatModel` inheritance remain in the adapters; only the pure parts of their helpers move. This type-only dependency does not put LangChain into core or make core's contracts framework-specific.

Choose **pure bridge helpers with no Worker subpath**. The root export is `@galaxie/adapter-kit`; this extraction adds no other public subpath. Importing any kit module must not read or create DOM/Worker globals, start a Worker, install listeners or modify `globalThis`. Bridge helpers consume and return ordinary values/text. Platform-neutral UTF-8 encoding occurs when a helper is called, not at import time. Worker ports, message handlers and startup stay in each adapter, so no exception to the kit's allowlist is needed.

The kit is a **launch package**, published and packable together with the existing launch packages because launch package `adapter-langgraph` will depend on it. It shares their release version, including core's release version; it has no independent release cadence. The extraction adds it to the launch inventories in `tests/conformance/package-pack.node.test.ts` and `scripts/check-dependency-licenses.ts`, including resolved workspace dependencies, public metadata, exports, README, LICENSE and NOTICE. The pack test must also check that packed adapter dependencies resolve the kit's release version. The kit and its contribution to the LangGraph consumer bundle are covered by the release size budget; extraction must establish that coverage and record the result, without hiding bytes in a new package or relaxing existing limits. This record claims no measured size saving.

### Ownership

Executor lifecycle, run state, cancellation/settlement, tracing integration, framework-specific graph/agent/Runner construction, tool and interaction mapping, restore and checkpoint handling, stored formats, the Pyodide loader and Python helpers, and the Go loader and WASM glue stay per-adapter. Framework-specific schema conversion, feature negotiation, output-limit forwarding and stream acceptance rules also stay there. Core retains routing policy, credential acquisition, labels, consent, budgets and broker authorization.

Code belongs in the kit only when at least two real adapters need the same operation and invariants, it fits one of the verified categories, and it meets the allowlist without an executor/framework switch. Otherwise it stays in the responsible adapter. A new category needs a separately justified decision; this package is not a general utility collection. Small adapter wrappers retain differing validation, error precedence and runtime-library calls.

### Migration

Extract only **after the ADK Go model/tool bridge stage has landed**, so the design generalizes from four real adapter instances. That stage's fourth copy is present in this workspace; its existence does not authorize code moves in this documentation change.

Move code, do not redesign it. Start each shared operation from the strictest baseline identified above; when copies have different protections or contracts, retain the caller-specific checks and move only the common part. Do not remove checks, change error messages, envelope versions, checkpoint formats or public adapter APIs to make the helpers uniform. Any necessary behavioral reconciliation is separate work, not hidden inside extraction.

Introduce the kit and its build/release/dependency gates, then migrate **one adapter per commit**. After each adapter step, that adapter's existing suites, native-owned goldens and compatibility matrices must pass unchanged in their existing Node and Chromium lanes before the next adapter moves. Shared helper fixtures supplement those tests; they do not replace them or authorize regenerated goldens.

### Precise dependency-rule changes for extraction

System design §4, rule 2's sentence "Other integration packages depend on `core` and on their own library: LangGraph.js, LangChain, the MCP SDK or React." gains the adapter-kit dependency for executor adapters. Replace "Packages do not import each other; the host app wires them together through `createRuntime` (brief §14.2)." with:

> Integration packages depend on core and their own libraries, with the existing models/storage exceptions. Executor adapters may additionally import `@galaxie/adapter-kit`. No adapter imports another adapter. The kit imports only core public exports, erased `@langchain/core` types and its own relative files; it imports no adapter. The host app wires the integration packages together through `createRuntime`.

All other §4 boundaries remain unchanged. `scripts/check-dependencies.ts` will implement that text as follows:

- Add exact `@galaxie/adapter-kit` to adapter import allowlists. Apply the adapter-to-adapter prohibition to LangGraph source/build/tests as well as the three other adapters, preserving existing framework-specific restrictions and test-only dependencies.
- Go and ADK currently reject `specifier.startsWith('@galaxie/adapter-')` and relative targets whose directory starts with `adapter-`. Explicitly classify `adapter-kit` as the non-adapter exception before those checks; reject all actual sibling adapters, including their subpaths and relative paths. Pyodide's explicit executor exclusions and allowlist gain the same complete prohibition and kit exception. Only the kit's public root is allowed; deep/undeclared kit subpaths and relative access to kit internals are not an alternative import path.
- Add a dedicated kit source/build import check for the exact allowlist above, including erased LangChain references in declarations and no runtime LangChain import in emitted JavaScript. Reject adapter imports, core deep imports, relative escapes and other dependencies. Kit tests may use test tooling under a test-only rule; that does not widen production imports or permit kit-to-adapter imports.
- Include kit distribution files in the existing built-package checks against `async_hooks` and Node imports. Add import-side-effect coverage for absent DOM/Worker globals. Preserve every existing adapter restriction, including ADK bundle boundaries and Pyodide's Worker-only runtime imports.

These are requirements for the later extraction. `scripts/check-dependencies.ts` is unchanged by this ADR.

### Amendment of the Go package rationale

This decision amends only [ADR-0023](0023-google-adk-go-through-a-wasm-worker.md), decision 1's premise that Go's Worker, bridge and loader "share nothing with Pyodide." The executor remains the separate `@galaxie/adapter-go` package. Its loader, glue and protocol-specific behavior remain local, while pure common bridge and adapter helpers may be shared through the kit once extraction changes the rules. Adapters still cannot import each other.

## Alternatives considered

- **Keep copying.** Avoids a package, but each model-output or bridge-validation correction must be repeated across four adapters, with drift in the controls documented above.
- **Put the helpers in `@galaxie/core`.** Would make the framework-neutral runtime own LangChain message shapes and worker transport details. Core's existing ports already own policy; adapter translation belongs outside it (ADR-0017).
- **Let adapters import one designated adapter.** Couples unrelated frameworks to that adapter's runtime dependencies and lifecycle, and defeats the independent-adapter rule. A non-adapter package exposes only the common helpers.
- **Extract before the Go adapter exists.** Would infer the fourth instance's framing, lifecycle and validation requirements. Wait for its actual model/tool bridge and preserve all four real behaviors instead.
- **Unify the Worker protocols or add a Worker runtime service.** Changes established wire formats and ownership rather than moving common logic. Pure framing/validation helpers need neither a new protocol nor a Worker startup abstraction.

## Consequences

- Corrections to shared extraction, provider resolution and validation have one owner; adapters keep framework behavior and existing security boundaries.
- A new public launch dependency adds packaging, license, version and size-budget obligations. Type-only LangChain references must not become runtime coupling.
- Existing validation differences limit what can move unchanged. The inventory's per-operation baselines prevent a smaller helper from silently weakening another adapter's checks; protocol and stored-data redesign remain out of scope.
- This proposal changes no implementation, package availability, goldens, matrices, controls, feature flags or documented unmeasured paths. No performance or real-model improvement is claimed.

## Verification

Before the extraction is considered implemented:

- Run the shared `toolCallChecks` fixtures against the kit and all four adapters and require identical shared-text output. Retain separate tests for growing fragments, raw mirrors, invalid calls, checked IDs/names, truncated JSON and adapter-specific executable-call conversion.
- Exercise service and provider fixtures for own-property lookup, missing providers, descriptor/factory mismatch, absent ephemeral credentials and invalid model/port shapes. Credentials remain host-side and existing credential scans pass.
- Run both adapters' existing bridge suites unchanged. Shared validator fixtures must reject the same malformed envelopes and payloads as today's tests: unknown versions/operations/fields, malformed calls, unexpected credential fields, invalid JSON and oversized UTF-8 frames. Preserve each protocol's current acceptance, error code and size boundary; no common envelope replaces them.
- Add `check:deps` positive fixtures for each adapter's kit import and the kit's permitted core/type imports. Negative fixtures cover adapter-to-adapter imports (including LangGraph, subpaths and relative bypasses), kit-to-adapter imports, core internals, LangChain runtime imports, forbidden framework/Node dependencies and relative escapes. `tests/conformance/check-dependencies.node.test.ts` is the existing dependency-rule test entry.
- Prove an import of the built kit works without DOM/Worker globals and creates no runtime side effects. Keep Worker-startup and framework-runtime dependencies in their adapters.
- Pass each migrated adapter's existing Node/Chromium suites, goldens and matrices unchanged after every step, then the repository checks. Pass the extended launch pack test and dependency-license check, verify the shared release version and resolved kit dependency in tarballs, and report kit/consumer size-budget results without increasing existing limits.

For this documentation-only proposal, run `node scripts/check-docs.ts` and `node scripts/check-license.ts`. The implementation verification above remains future work.
