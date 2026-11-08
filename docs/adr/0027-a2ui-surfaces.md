# ADR-0027: A2UI surfaces with host-owned catalogs and policy

- **Status:** Accepted (maintainer decision, 2026-11-08)
- **Date:** 2026-11-07
- **Related:** brief §5.2, §9.2, §11, §12; ADR-0004, ADR-0007, ADR-0010, ADR-0012, ADR-0014
- **Revisions:**
  - 2026-11-08: accepted after the protocol package, core pending surfaces and the React renderer merged. The cost named under Consequences stays open: galaxie owns validation of a young specification, and a commit pin only limits drift, not the maintenance effort.

## Context

The current interaction selects one component and supplies its props. It cannot describe a composed surface or update its components and data independently. [Brief §11](../galaxie-project-brief.md#11-generative-ui-the-agent-drives-the-experience-the-host-owns-the-dom) already assigns catalogs, regions and DOM ownership to the host. A2UI supplies the surface messages; galaxie still owns identity, checkpoint consistency, revisions, data labels and policy.

This proposal would supersede the registry-format decision in [ADR-0007](0007-typed-ui-registry-for-mvp.md) and lift only the A2UI renderer deferral in [ADR-0010](0010-mvp-scope-cuts.md). Their statuses and current decisions remain unchanged until this ADR is accepted. It preserves the checkpoint source of truth in [ADR-0004](0004-interrupt-as-pending-interaction-source.md), the mandatory controls in [ADR-0012](0012-security-baseline.md) and the sticky-label policy in [ADR-0014](0014-data-labels-and-argument-shapes.md). It does not authorize LLM-composed UI as an MVP feature.

### Current implementation evidence

These are observations of the source, not claims that A2UI is implemented:

| Current behavior | Source |
| --- | --- |
| `InteractionRequest` is exactly `{ surfaceId, viewRevision, component, props }`, with nonempty string identity and plain JSON props. `surfaceId` is the host region; `ViewRevision` is a branded string, not a number. | [`interactions.ts`](../../packages/core/src/interactions.ts), [`ids.ts`](../../packages/core/src/ids.ts) |
| The LangGraph adapter reads pending requests from checkpoint interrupts, adds the engine interrupt ID and resumes with `{ action, payload }`. It rejects multiple distinct pending interrupt IDs. There is no pending-surface checkpoint mutation port today. | [`interaction.ts`](../../packages/adapter-langgraph/src/interaction.ts), [`adapter.ts`](../../packages/adapter-langgraph/src/adapter.ts), [`executor.ts`](../../packages/core/src/executor.ts) |
| Core checks bound components, host regions, event identity, actions and payloads. Dispatch returns `accepted` or `rejected`; `duplicate` and `stale` are rejection error codes, not separate receipt statuses. | [`interactions.ts`](../../packages/core/src/interactions.ts), [`agent-instance.ts`](../../packages/core/src/agent-instance.ts) |
| Core's submission payload limit is serialized UTF-8 JSON, default 1,048,576 bytes. Defaults also declare `uiElements: 50` and `repairAttempts: 2`; the current interaction path does not enforce a component-tree count. Routed model repair is opt-in and uses the shared repair budget. | [`budgets.ts`](../../packages/core/src/budgets.ts), [`policy.ts`](../../packages/core/src/policy.ts), [`model-router.ts`](../../packages/core/src/model-router.ts) |
| The registry validates synchronous Standard Schema props, registered actions and schema-declared URLs. Components receive `{ props, actions, status }`; labels on actions come from trusted registrations. The surface captures render-time identity and remounts on identity/revision changes. | [`registry.ts`](../../packages/react/src/registry.ts), [`surface.tsx`](../../packages/react/src/surface.tsx) |
| Quiz selection and WritingPrompt drafts are local React state. Quiz uses labelled radio groups; WritingPrompt uses a labelled textarea. Feedback is a list; Progress is a labelled native progress element. Neither Feedback nor Progress currently creates a live region or moves focus. | [`quiz.tsx`](../../packages/react/src/components/quiz.tsx), [`writing-prompt.tsx`](../../packages/react/src/components/writing-prompt.tsx), [`feedback.tsx`](../../packages/react/src/components/feedback.tsx), [`progress.tsx`](../../packages/react/src/components/progress.tsx) |
| Quiz/WritingPrompt rejection alerts use fixed text, `role="alert"`, `aria-describedby` and transition-only focus. Render failures use a fixed alert focused on mount. Core records content-free outcomes without changing `waiting_input`; a failed outcome is sticky for that interaction/revision. The public instance has `cancel`, but no `fail` or render-retry method. | [`submission-error.tsx`](../../packages/react/src/components/submission-error.tsx), [`alert-focus.ts`](../../packages/react/src/components/alert-focus.ts), [`surface.tsx`](../../packages/react/src/surface.tsx), [`agent-instance.ts`](../../packages/core/src/agent-instance.ts), [`instance.ts`](../../packages/core/src/instance.ts) |
| Labels accumulate on the run. The broker registers labels and private strings from validated capability outputs. Restore creates a fresh run ID with conservative run labels and registers accepted payload strings; adapters can report restored data through `registerRestoredData`. Core checks pending props with its recursive URL/private-value policy. | [`annotations.ts`](../../packages/core/src/annotations.ts), [`capability-broker.ts`](../../packages/core/src/capability-broker.ts), [`agent-instance.ts`](../../packages/core/src/agent-instance.ts), [`private-values.ts`](../../packages/core/src/private-values.ts), [`interactions.ts`](../../packages/core/src/interactions.ts) |
| The tutor and both templates issue the four-field requests; the tutor separates its quiz answer key from display props and grades in graph code. | [`tutor graph`](../../examples/english-tutor/src/graph.ts), [`local-only agent`](../../templates/local-only/src/agent.ts), [`hybrid-gateway agent`](../../templates/hybrid-gateway/src/agent.ts) |

## Decision

The following is a contract for later implementation. This record adds no runtime behavior or package.

### Protocol pin and compatibility

Pin **A2UI v1.0**, wire `version: "1.0"`, to specification commit **`dee8167996b0a802b18b3ebe51f3515c55b757de`**, dated 2026-11-06. The pin is the spec version and commit, not a renderer SDK version.

These external facts were checked on 2026-11-07 against the upstream repository and the npm registry:

- The upstream [version registry](https://github.com/a2ui-project/a2ui/blob/dee8167996b0a802b18b3ebe51f3515c55b757de/specification/versions.json), which declares itself the single source of truth for protocol status, marks v1.0 `current`, v0.9.1 and v0.9 `previous`, and v0.8 `deprecated`. The pinned commit made v1.0 current and is the latest change to `specification/v1_0` as of that check. See the [v1.0 specification](https://a2ui.org/specification/v1.0-a2ui/) and [pinned protocol text](https://github.com/a2ui-project/a2ui/blob/dee8167996b0a802b18b3ebe51f3515c55b757de/specification/v1_0/docs/a2ui_protocol.md).
- Evidence disagrees at the edges: the repository README still says “Moving towards a v1.0 specification”, and third-party accounts dated 2026-11-04 called it a release candidate. There are no protocol git release tags, only SDK tags. This is a young specification with uncertain release messaging; the exact commit makes the chosen contract reproducible without resolving that disagreement by assumption.

Changing either part of the pin requires a revision of this ADR and the protocol package's version constant. Checkpoints carry both `specVersion` and `specRevision`. An upgrade must retain support for restoring records under the old pin, including its catalog semantics and validation, with restore tests before the constant changes. Restore never silently reinterprets an old surface using the new pin.

“Additive within a version” is not permission to accept arbitrary extensions. The pinned validator rejects unknown top-level and nested message fields and component properties outside the bound catalog. An upstream optional addition needs explicit schema support and tests; it is not ignored merely because the wire version is still `1.0`. `metadata.extensions` accepts only host-registered extension schemas and cannot supply authority or labels.

### Trusted envelope and identity

Preserve today's meaning of `surfaceId`: it is the host-assigned region such as `lesson-main`. Name the separate A2UI identity `a2uiSurfaceId`. The galaxie envelope has these fields:

| Field | Owner and meaning |
| --- | --- |
| `instanceId`, `runId` | Core's current instance and run; restore creates a fresh `runId` and uses the restoring instance's `instanceId`. |
| `interactionId` | Engine interrupt ID, or deterministic host/checkpoint identity as in ADR-0004. |
| `surfaceId` | Region granted by the host to this instance; never navigation, payment UI or another agent's region. |
| `a2uiSurfaceId` | Host-allocated surface identity, globally unique for the renderer lifetime. Each A2UI message's `surfaceId` must match it. |
| `revision` | Core-owned nonnegative safe integer; first accepted creation is revision 1, then one increment per accepted batch. |
| `viewRevision` | Existing opaque `ViewRevision` string, derived by core from `a2uiSurfaceId` and `revision`; not a change of the existing branded string type to a number. |
| `specVersion`, `specRevision` | The protocol package's pinned constants, persisted with the record. |
| `catalogId` | Host-bound catalog identifier, initially `education/v1`; an identifier, not a URL to resolve or code to download. |
| `labels` | Trusted, sticky `DataLabel` union attached to this revision, as described below. |

None of these fields may come from model output. Agent code receives a trusted binding for its surface; a message's repeated identity/catalog/version must agree with that binding. A supplied `catalogId` cannot rebind a surface; an omitted one uses the host binding. Component IDs inside the surface are local adjacency-list IDs and do not grant a region. Creating a live A2UI ID twice fails `INTEGRITY_ERROR`; deletion is required before recreation. Recreation continues the stored revision counter so an earlier event cannot match it.

The first implementation retains one pending interaction per run. Composition does not add parallel interrupts or authorize an agent to arbitrate regions. Actions retain today's identity checks and also identify the originating component inside the A2UI surface. Core validates that component's registered event/action and payload, then submits through the existing inbox. The action includes the `revision` and derived `viewRevision` at which it was rendered. Core checks both against committed pending state, not only against an in-memory projection.

### Materialized checkpoint and revision publication

Store the **reduced result**, not an A2UI message log, in a versioned pending record with `format: "galaxie.surface/1"`: a flat `components` map keyed by component ID, the root `dataModel` object, `catalogId`, `revision`, `viewRevision`, `specVersion`, `specRevision`, `labels`, the region and the A2UI identity. The pending interrupt remains the authoritative checkpoint anchor. Live instance/run IDs are attached on publication, not restored as live identities from the old run. Keep a deletion marker and its revision when the surface is deleted so delayed actions cannot target removed content. Legacy normalization may retain `legacyViewRevision` as an engine-anchor token; it is not a second copy of the display state.

Apply each batch to a candidate copy, in wire order, and validate the complete candidate before committing it. `createSurface` applies its initial data model before its initial components and requires a component with `id: "root"`; the canonical A2UI `Surface` container is implicit. `updateComponents` upserts a flat list; references use catalog-declared `ComponentId`/`ChildList` types. `updateDataModel` uses JSON Pointer `path` (default `/`) and `value`; `null` deletes the addressed key. `deleteSurface` removes the displayed surface. A rejected batch changes neither stored content nor revision. Incomplete streamed JSON is never a candidate or a reason to render.

Every accepted nonempty batch increments the revision once, including an accepted deletion or a batch whose final content equals its previous content. No individual message within it is published. Use the existing `payloadBytes` limit (default **1,048,576 UTF-8 bytes**) for the incoming batch, complete materialized checkpoint record and action including its whole data model. Enforce the existing `uiElements` limit (default **50**) against materialized components and expanded template instances, not just the latest delta; count domain components as one each, preserving their existing internal bounds. The implicit `Surface` is not a catalog component. Above either cap, reject the whole candidate with the distinct fixed code below; do not truncate, evict existing components, save a partial state or advance the revision. Restore enforces the same caps before publication.

The core pending-surface implementation must supply an executor-owned checkpoint commit path that compares interaction identity and expected revision, commits the materialized replacement, and acknowledges it before publication. Today's `ExecutorAgent` has no such method; a new in-memory reducer alone cannot fulfill this contract. A failed write leaves the previous committed revision authoritative. Do not introduce a second durable UI projection or message journal alongside the engine's pending state. This checkpoint integration belongs to the later core work, including the LangGraph bridge; it is not claimed to exist here.

### Validation is the trust boundary

The protocol validator runs before checkpoint writes or publication, including restore and action submission. The renderer only receives validated, materialized state. It must not become the sole owner of a policy check. Validation includes:

- Strict plain JSON envelopes with `version: "1.0"` and exactly one of the six v1.0 agent-message keys. The first implementation accepts only `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface`.
- Every component and property against the bound catalog, including allowed parents/children; one `root` component in every live surface; unique component IDs within an update; every ID reference resolved; and no adjacency cycles, including disconnected components.
- Every data binding, expressed as `{"@path": "/x"}`, against the resulting data model. Absolute JSON Pointers stay inside that root; relative pointers are allowed only in a list template and resolve inside its item. Invalid escapes, missing targets or values that fail the target property's schema reject the batch. Reject `@`-prefixed keys at every depth of the data model. System context such as `@index` and `@call` is produced by trusted runtime code, not data-model keys or model-supplied context.
- Catalog URL properties as **literal strings only**. Any data binding on a URL-typed property is rejected, even if its current value is allowlisted; future data updates must not redirect a previously accepted binding. URL strings used as single attributes reject ASCII whitespace, credentials and non-allowlisted origins, using the existing `isAllowedUrl` rules: HTTPS, or HTTP only on the recognized loopback hosts. No CSS URLs, `srcset` lists, arbitrary HTML or JavaScript handlers are introduced.
- The full recursive `checkInteractionUrlPolicy` over **both components and data model**, with the run's registered private values, before every revision is published. This retains the existing URL-like-string backup as well as catalog URL typing. An origin allowlist does not constrain paths or queries, the scanner does not detect arbitrary embedded URLs, and verbatim matching does not detect paraphrases; ADR-0012's limits remain.
- Batch, materialized-state, action and expanded-component caps, and catalog-defined function registration, argument/result schemas, caller permissions and activation requirements.

Failures expose a content-free fixed protocol `code`. They are not new values silently added to today's core `ErrorCode`; core maps them to its existing error categories while retaining the protocol code for bounded repair. Distinct checks have distinct codes:

| Rejected condition | Protocol code | Core category |
| --- | --- | --- |
| Malformed JSON/message shape or more than one message key | `INVALID_MESSAGE` | `invalid` |
| A different spec pin | `UNSUPPORTED_VERSION` | `unsupported` |
| `callRendererFunction` | `UNSUPPORTED_RENDERER_MESSAGE` | `unsupported` |
| `agentFunctionResponse` | `UNSUPPORTED_AGENT_RESPONSE` | `unsupported` |
| `theme` on `createSurface` (removed in v1.0) | `UNSUPPORTED_THEME` | `invalid` |
| Explicit `sendDataModel: false` | `DATA_MODEL_REQUIRED` | `unsupported` |
| Unknown message field or unregistered extension | `UNKNOWN_FIELD` | `invalid` |
| Envelope/message identity mismatch or a catalog rebinding | `BINDING_MISMATCH` | `denied` |
| Creating an existing live surface or updating/deleting a nonexistent one | `INTEGRITY_ERROR` | `invalid` |
| Duplicate component ID within a list | `DUPLICATE_COMPONENT_ID` | `invalid` |
| Unknown catalog component | `UNKNOWN_COMPONENT` | `unsupported` |
| Invalid or unknown component property | `INVALID_COMPONENT_PROPERTY` | `invalid` |
| Missing `root` | `MISSING_ROOT` | `invalid` |
| Unresolved component reference | `UNRESOLVED_REFERENCE` | `invalid` |
| Adjacency cycle | `CYCLIC_COMPONENTS` | `invalid` |
| Forbidden parent / child | `UNALLOWED_PARENT` / `UNALLOWED_CHILD` | `invalid` |
| Invalid, missing or escaping data path | `INVALID_DATA_PATH` | `invalid` |
| Reserved data-model key | `RESERVED_DATA_KEY` | `invalid` |
| Data binding on a URL property | `URL_BINDING_FORBIDDEN` | `denied` |
| URL allowlist / private-value URL failure | `URL_NOT_ALLOWED` / `PRIVATE_VALUE_IN_URL` | `denied` |
| Serialized byte / expanded component limit | `PAYLOAD_TOO_LARGE` / `TOO_MANY_COMPONENTS` | `budget_exceeded` |
| Unknown or unregistered function | `UNKNOWN_FUNCTION` | `unsupported` |
| Caller / activation violation | `FUNCTION_CALLER_DENIED` / `USER_ACTIVATION_REQUIRED` | `denied` |
| Invalid function arguments / result or thrown pure function | `INVALID_FUNCTION_ARGUMENTS` / `EXECUTION_ERROR` | `invalid` |

Check message shape and supported features first, then binding, limits, catalog schemas, graph integrity, paths, functions and URL policy in a deterministic order. Known-but-unsupported fields/messages get their explicit codes before generic unknown-field handling. Any later check failure still rolls back the whole batch. Fixed function errors never include thrown messages or values. The boolean URL-policy helper can be applied first without and then with private values to distinguish URL rejection from a private-value match without exposing the matched text.

When agent code uses a model to produce surface data, these codes feed the existing bounded structured-output repair path. Repairs remain host-enabled, use ordinary model routing/labels and the shared `repairAttempts` budget (default 2), and stop on exhaustion; do not create an unbounded renderer repair loop. Rejected data never reaches the DOM while a repair is pending.

### Catalog and accessible rendering

Galaxie ships **no visual design**. The host binds catalog names to reviewed components, props/action schemas and labels; it owns styling and layout. No component named by a model is downloaded. The initial galaxie catalog keeps the tutor's four domain entries and offers only `Column`, `Row`, `Text` and `Card` for composition. It is a deliberate subset/custom catalog, not a claim to implement the entire upstream basic catalog (Image, Icon, Video, AudioPlayer, List, Tabs, Divider, Modal, Button, CheckBox, TextField, DateTimeInput, ChoicePicker and Slider are not added by this decision).

| Catalog component | Required semantics |
| --- | --- |
| `Quiz` (`education.Quiz/v1`) | Preserve the optional heading, one `fieldset`/`legend` per question, labelled native radios grouped per question and separately per mounted form, and complete-answer gating. Submit only the selected question/option IDs as `{ answers }`. Keep the trusted “Submit answers” label, disabled inputs/submit while submitting or accepted, and answers on rejected retry. Keep the existing schema bounds, duplicate-ID checks and `__proto__` question-ID behavior. |
| `WritingPrompt` (`education.WritingPrompt/v1`) | Preserve optional heading, explicit label/textarea association, placeholder, default/max 500-character input, and nonempty trimmed `{ sentence }` submission with the trusted “Submit sentence” label. Keep local drafts on rejection, disable editing/submission while submitting or accepted, and label submitted text `private-user`. |
| `Feedback` (`education.Feedback/v1`) | Preserve the section, optional heading, `ul`/`li` feedback with textual `correct`, `incorrect` or `info` kind, and trusted “Continue” action with `{}`. Keep existing item bounds and disabled continue while submitting or accepted. No automatic live announcement or focus move is inferred from feedback content. |
| `Progress` (`education.Progress/v1`) | Preserve the label (default “Progress”), native `progress` value/max, textual `current / total`, bounds `0 <= current <= total` and trusted “Continue” with `{}`. Keep disabled continue while submitting or accepted. No automatic live announcement or focus move is inferred from progress changes. |
| `Column`, `Row` | Ordered `ChildList` references; DOM reading and keyboard order follow declared order regardless of visual arrangement. They introduce no focus stop or implicit live region. Named grouping and descriptions are mapped when explicitly supplied. |
| `Text` | Text content only, rendered as text rather than HTML or executable markdown. Accessible text remains in reading order; no automatic focus or live region. |
| `Card` | A content group with ordered children; expose a supplied label/description as an accessible group name/description. No implicit interactive role, tab stop or live region. |

All existing domain props/action schemas and bounds survive, not just the examples in this table. Keep `educationComponents` as the existing four-entry export; structural registrations are separate, so existing host bindings and tests do not silently grow. Map A2UI names to those entries through the trusted bound catalog.

Catalogs and renderers must map A2UI `AccessibilityAttributes`: `label` to the accessible name, `description` to an associated accessible description, `live` to the framework's live-region API, and `hidden` to accessibility-tree visibility. Infer defaults from native/domain semantics; explicit attributes override inferred defaults. This does not permit replacing the required fieldset, labels, native controls or trusted action text with model HTML. Other renderers must preserve equivalent semantics in their framework's accessibility APIs.

Retain `InteractionStatus`: `idle`, `submitting`, `accepted`, or `{ rejected: error.code }`. A core rejected receipt, including `duplicate` or `stale`, reaches the initiating component through that status prop. The surface's local double-submit guard must also return `duplicate`; do not dispatch twice. An accepted action stays disabled; a rejection re-enables retry and keeps the local answer.

For Quiz and WritingPrompt preserve the current fixed `role="alert"` text: invalid → “Check your answer and try again.”; duplicate → “This answer was already sent.”; stale → “This question is no longer active.”; other rejection → “Your answer could not be sent. Try again.” The alert is linked from submit by `aria-describedby`, has `tabIndex={-1}`, and takes focus only on a transition into rejection. Initial rejected mount and a change from one rejected code to another do not steal focus; leaving rejection clears the alert. This is the announcement users see and hear, with no model text or answer echo. For Feedback/Progress continue-action rejection, the surface must supply the same fixed status announcement/focus behavior rather than dropping their status; avoid duplicating alerts inside Quiz/WritingPrompt. The render-failure fallback remains the separate fixed alert “This step could not be shown.” focused once on mount.

The migration acceptance bar is that [`components.test.tsx`](../../packages/react/test/components.test.tsx) and [`education-a11y.test.tsx`](../../tests/conformance/education-a11y.test.tsx) pass with **only import changes**. Do not weaken assertions, rewrite fixtures or replace domain components with low-level form assembly to fit A2UI. Additional surface tests cover new composition and continue-action status behavior.

### Render failure, updates and local answers

A render failure leaves the run paused in `waiting_input`. Core records the fixed render outcome; it never fails the run on its own because rendering failed. Failure does not change the revision. The host may remount/retry rendering the same surface, or terminate it through existing `cancel(runId)`/fallback controls and offer Start over. An executor-reported error can fail a run through the existing error-event path. There is no public host `fail(runId)` API today, so this ADR does not promise one or disguise cancellation as a `failed` terminal status.

Accepted updates **continue to apply to the stored surface while rendering is failed**, using the same validation, checkpoint and revision rules. A retry renders the latest committed revision. Uncommitted changes never appear. The renderer's boundary must reset for an explicit host remount or a new revision; a failure does not freeze the checkpoint. Preserve today's content-free outcome reporting and sticky failure for the same interaction/revision; a same-revision remount can succeed visually without rewriting the earlier failure record. A new revision has a new outcome key. Actions from an earlier rendered revision reject `stale`, subject to today's precedence of instance/run identity and an already accepted interaction's `duplicate` receipt.

**Unsubmitted answers do not survive reload in this version.** Typing and option selection update renderer-local state/data bindings only. They do not invoke the model, call core or write checkpoints. Remount/reload resets them, matching today's tutor. If a new revision changes the interaction while a draft exists, visibly notify the user that the step changed; never silently substitute questions under an old answer.

The equivalent of `sendDataModel: true` is always on: omission is normalized to true, explicit false rejects. Every action includes the whole local data model to the surface's owning agent only. A submitted action validates that model and its domain payload together; trusted input schemas mark user-entered values `private-user`, and core registers their private strings **before any accepted submission/checkpoint storage or publication**. The renderer cannot declare a user value public. Unchanged agent-provided fields retain their trusted source labels; changes to writable input paths gain `private-user`, and changes to non-writable agent fields are rejected. The existing agent-facing `{ action, payload }` stays intact on the compatibility path below; the attached data model is core-owned transport metadata, not an extra key in the domain payload.

Revisit draft persistence only with evidence that reloads lose meaningful user work. That design must specify an explicit save trigger/opt-in or bounded autosave cadence, apply `private-user` and register private strings before the first storage write, use the same scoped storage/logout/retention controls, and show a restore notice identifying that a saved draft has been restored. This ADR adds no draft storage or per-keystroke core messages.

### Functions and data provenance

A component action is either an A2UI `event` with a registered `name`, optional `userMessage` and validated `context`, or a `functionCall` to a registered renderer function. Treat `userMessage` as untrusted text, never an action label or confirmation. Reserved `@` system context is supplied by the runtime. Events submit through core; pure function calls execute locally and do not resume the agent.

Renderer computation functions such as `formatString`, `required` and `regex` are host-registered, deterministic and pure: no network, storage or DOM side effects, and no raw code from the wire. Their catalog definitions include schemas, `allowedCallers` (`rendererOnly`, `agentOnly` or `rendererOrAgent`) and `requiresUserActivation`. The validator rejects unknown/unregistered functions and invalid call sites; the renderer enforces caller and activation restrictions again when invoking a function. The first catalog registers only the pure functions it implements, not an implicit allowlist of every upstream function.

`openUrl`-style effects are not pure computation functions and are not registered in the initial catalog. Any later host registration of such an action must remain **`rendererOnly`**, require an actual user gesture, take only a policy-checked literal URL, and pass the URL/private-value policy at invocation. An agent message cannot synthesize activation or call it remotely. This rule does not permit arbitrary DOM callbacks in the computation registry.

Agent-side functions (`callAgentFunction`) are **deferred**. If introduced, each name must map to a host-bound capability through the broker, with request/response schemas, grants, budgets, labels and the broker's confirmation for writes/significant effects under ADR-0012 and brief §9.2. Never execute code strings, evaluate a function body from a message or bypass broker authorization. Until that integration and its tests land, attempts reject with fixed `UNSUPPORTED_AGENT_FUNCTION` (`unsupported`); `agentFunctionResponse` remains rejected as above.

`labels` travels with every materialized surface revision and is persisted with it. Use a conservative whole-revision union of the run's sticky labels and the trusted labels of all incorporated sources; this adds no claim of precise field-level taint tracking. Agent-provided content keeps its source labels, including the broker's labels on a capability result; unlabelled capability content retains the existing `app` default. Model-derived content inherits the run labels, never labels chosen by the model. Every user-entered value gains `private-user`. Deleting a component/value does not remove a label from the run or a later revision.

On restore, re-register the stored surface's private strings before any policy check or live outbound operation, preserve its recorded labels, and retain core's current conservative restore labels. Before **every** publication (create, component/data update, action-carried data model or reload), core runs `checkInteractionUrlPolicy` over the entire materialized components and data model with the run's private-value registry, in addition to literal catalog URL checks. This explicitly extends today's pending-props check to the whole surface, closing the path where a later data update could otherwise publish a private value in a URL. It does not weaken any destination or confirmation control in ADR-0012.

### Implementation ownership and renderer choice

Build a galaxie-owned protocol package for message types, strict catalog validation and a pure reducer, plus a thin A2UI renderer in `@galaxie-ai/react`. The protocol package is framework-neutral and imports neither core nor React; core supplies trusted catalogs, limits and the mandatory URL/private-value policy predicates, owns identity/provenance and commits pending surfaces. React maps validated catalog names to host registrations and owns only local input state, accessibility and render outcomes. Core may depend on the protocol package; the package must not depend back on core. The later package work must update the dependency/build inventories for that boundary. The package name is an implementation choice; its wire constants are the pin above.

Take **no runtime dependency on any `@a2ui/*` package**. The npm registry showed this on 2026-11-07:

- [`@a2ui/react` 0.15.0](https://www.npmjs.com/package/@a2ui/react/v/0.15.0), Apache-2.0, modified 2026-11-02, depends on `@a2ui/web_core` ^0.15.0, `@a2ui/markdown-it`, `markdown-it` and `clsx`, and requires peer **`zod` ^3.25.76**. galaxie's [`React`](../../packages/react/package.json) and [`core`](../../packages/core/package.json) peers are **`zod` ^4.6.0**; those ranges conflict.
- [`@a2ui/web_core`](https://www.npmjs.com/package/@a2ui/web_core) uses `@preact/signals-core`, `MessageProcessor`, `SurfaceModel`, `DataModel` and `Catalog`, supporting v0.9 and v1.0. It would duplicate the materialized state galaxie must checkpoint, without a seam for galaxie's revisions, labels, URL policy or private-value check. Its 0.x SDK versions are independent of the protocol version, adding another changing contract.

This choice costs implementation and maintenance: galaxie must track the spec itself and own validator/reducer correctness. Use the pinned A2UI JSON schemas and sample messages as **test vectors only**, not runtime dependencies; record Apache-2.0 attribution and the upstream commit wherever fixtures are copied, with the package's license/notice inventory. No upstream code or fixtures are copied by this ADR. Changing the renderer/reducer dependency choice requires a revision of this ADR.

### Compatibility with single-component requests

Continue to accept today's exact four-field `InteractionRequest` and old checkpoint interrupt payloads. The compatibility adapter recognizes that shape, resolves the registered component and catalog from trusted bindings, and constructs a one-component A2UI surface whose `root` is that domain component. Its props remain the original props; it starts with an empty data model unless the trusted registration declares input bindings. Core allocates `a2uiSurfaceId`, numeric revision and the new revision token, while the compatibility bridge preserves/checks the original request's `viewRevision` as `legacyViewRevision` when addressing a legacy engine checkpoint. The current opaque agent-authored revision is a legacy request token, not a numeric counter obtained from model output.

Agent code continues to pass `{ surfaceId, viewRevision, component, props }` to `requestInteraction`; do not add A2UI keys to the strict old request parser. The pending bridge reads either the old raw interrupt or the new versioned materialized record. It must commit a normalized surface before publishing its new identity/revision; later updates replace that record, not the old props plus a separate authoritative projection. Engine-specific checkpoint integration preserves interrupt/resume identity without asking old agent nodes to emit new messages. Old stored requests normalize through the same mapping on restore. UI events still use the current public identity fields; the new core path binds their revision to the normalized pending surface and verifies its checkpoint anchor. For old pending objects received directly by `AgentSurface`, normalize internally without requiring callers or existing test fakes to change their shape.

Quiz still returns `{ action: "submit", payload: { answers } }`, WritingPrompt `{ action: "submit", payload: { sentence } }`, and Feedback/Progress `{ action: "continue", payload: {} }`. A2UI context/data-model metadata cannot leak into these payload shapes. Existing agents, the tutor and both templates require **no agent-side changes**. Later tutor migration changes host/renderer wiring and exercises the normalized surface path. Removal of the old request shape is outside this ADR's scope: **not before a superseding ADR**.

### Deferred work and revisit conditions

| Topic | Decision and revisit condition |
| --- | --- |
| [Express inference-format compiler](https://github.com/a2ui-project/a2ui/tree/dee8167996b0a802b18b3ebe51f3515c55b757de/specification/inference_formats/express) and local-model format evaluation | **Deferred.** Revisit when an actual model-authored surface workflow needs a wire-format choice. Compare valid-message rate after the same validator, generated tokens and time to first validated component on named local models, retaining pin/catalog/repair limits. Do not add a compiler or claim performance benefits here. |
| LLM-composed surfaces under constrained decoding | **Deferred** as a product mode, per brief §11.2. Surface messages come from agent code. If a model writes any message/data, the same catalog validator and bounded repair loop apply; constrained decoding does not replace them. No autonomous catalog growth, downloaded components or low-level form explosion. Revisit after the MVP with a concrete domain workflow, model evidence, a tighter allowlist and composition tests. |
| `callAgentFunction` into the capability broker | **Deferred.** Revisit when a concrete catalog interaction requires an agent-side capability and broker mapping, write confirmations, authorization, replay/idempotency and cancellation tests are supplied. Until then reject, rather than translating it into an unchecked callback. |

## Alternatives considered

- **Keep the single-component format.** Small and already implemented, but cannot represent composition or independent data/component updates; keep it as the compatibility input, not the new surface representation.
- **Adopt `@a2ui/react` and `@a2ui/web_core` directly.** Reuses more upstream implementation but conflicts with the Zod peer range and duplicates checkpoint state without galaxie's policy/revision seams; 0.x churn adds a separate pin.
- **json-render.** Useful for LLM-composed UI, but that mode remains deferred and does not remove galaxie's checkpoint, identity or policy obligations.
- **MCP Apps iframes.** Appropriate when MCP servers supply UI resources, not the current bundled tutor/domain components and host-owned in-page regions; defer that bridge.
- **An older A2UI version.** v0.9/v0.9.1 are previous and v0.8 deprecated in the authoritative registry; an older wire contract does not resolve the release-message disagreement or checkpoint-policy ownership.

## Consequences

Three implementation pieces follow this proposal: the framework-neutral protocol package and conformance vectors; core pending surfaces with trusted envelopes, atomic checkpoint integration, labels and revision-aware dispatch; and the thin React renderer plus tutor host migration, preserving the old agent inputs and reference-component semantics. None is implemented by this documentation change.

The host retains its visual design, regions, capability authority and accessible components. Domain-first composition stays small. Materialized snapshots bound storage and make reload independent of message replay, but require a real checkpoint commit seam rather than duplicate UI state. Rejected batches and render failures remain separate outcomes.

Owning validation means galaxie must maintain graph/path checks, catalog evolution, protocol fixtures, historical-pin restore support and browser/Node parity. The specification is young and its release evidence disagrees; a commit pin and sample vectors constrain drift, not future maintenance cost. Drafts still disappear on reload. Function effects, format optimization and autonomous composition remain deferred. Existing trusted-first, origin/path-query and private-value matching limits remain documented; no broader deployment claim follows from this proposal.

## Verification

Before these decisions are considered implemented:

- Run the protocol package's validator/reducer tests on **Node and Chromium** with the same pinned schemas/sample messages. Cover create ordering, implicit Surface/root, data deletion, component upsert, atomic batch rollback and deletion/recreation. Keep valid upstream vectors and intentional subset rejections separate; verify every fixed error code, unknown fields/properties, unsupported message variants, `theme` and false `sendDataModel`.
- Exercise unresolved/cyclic/forbidden references, absolute and template-relative paths, reserved data keys, catalog mismatch, URL literals and bound URLs, private-value URL checks after data-only updates, function callers/activation, and byte/expanded-element boundaries. Protocol imports must have no DOM/Worker or framework side effects. Copied vectors carry attribution and their source commit.
- A **restore-after-reload** test must persist a composed materialized surface, reopen scoped storage and restore identical components, data, catalog, numeric revision, spec pin and labels, with fresh runtime identity and no model regeneration. Old-pin fixtures must still restore after a pin upgrade. Old four-field tutor/template checkpoints also restore. An unsent draft/choice must be absent; an accepted submitted model must carry `private-user` before its first storage write.
- A **stale-revision** test renders a revision, accepts a later batch, and dispatches the earlier action: fixed `stale`, no resume or inbox acceptance. Cover duplicate receipts, fresh restored identity, deleted/recreated surfaces, wrong host regions and compare-and-set races. A failed checkpoint write never publishes a candidate.
- Fault a render and prove the run remains `waiting_input`, revision unchanged, content-free failure reporting, host cancellation, same-revision host remount, and a valid update during failure followed by retry of the latest revision. Preserve the existing sticky failure outcome semantics without inferring automatic run failure.
- Pass the tutor, both templates and existing interaction/URL/recovery suites in their existing lanes. Pass `packages/react/test/components.test.tsx` and `tests/conformance/education-a11y.test.tsx` with **only import changes**, including native grouping, keyboard completion, busy state, fixed rejection announcements and focus rules. Add composition, accessibility-attribute and continue-action rejection coverage without weakening those suites.

For this documentation-only proposal, run `pnpm run check:docs` (or `node scripts/check-docs.ts` when pnpm is unavailable) and inspect the ADR index and all changed links. The implementation tests above are future acceptance conditions, not evidence from this change.
