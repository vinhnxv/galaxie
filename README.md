# galaxie

A browser-first agent runtime SDK for web apps.

galaxie lets a web application host AI agents as first-class parts of the app. Each agent has an identity, state, a lifecycle, permissions, a UI region and a recovery story.

The agent pipeline (a single agent, a multi-agent system, or the harness around them) runs in the browser on the user's own device, so the developer deploys no agent backend and no container for it. The app's backend keeps its APIs, MCP servers, databases and tools.

Agent logic stays in the frameworks developers already use, such as LangGraph.js, and the goal is parity: code written with LangChain and LangGraph should behave in the browser as it does natively on a server. galaxie's contracts are framework-neutral, so other frameworks can follow through adapters.

The runtime is designed to add what the browser lacks:

- **Model routing:** local models in the browser (WebGPU), Chrome Built-in AI, a model server on the user's machine, or an OpenAI-compatible endpoint chosen by the app or the user, under a per-role policy.
- **A capability broker:** agents act only within the app's own permissions, deny-by-default.
- **UI through the app's own components:** the agent drives an assigned UI region, provides data to the app and asks it to act, such as navigating, through capabilities the host binds; the host owns the DOM.
- **Recovery:** a reload, a second tab or a double click does not repeat a side effect or lose a pending answer.
- **A mandatory security baseline** on every path the SDK controls.
- **Development tracing:** OpenTelemetry spans that a tool such as Langfuse can show, through an exporter the host registers.

> **Status: M1 runtime controls, M2 local models, routing and typed React UI.** The workspace includes instance and run lifecycles, cancellation, replayable in-memory events, a LangGraph.js adapter, a capability broker with grants and validation, sticky data labels and argument shapes, finite step/tool-call/wall-clock/payload/token/cost budgets, and allowlisted OpenTelemetry spans. The model router selects providers per role under destination allowlists, labels and consent, with per-call credentials and route snapshots. An in-memory submission inbox confirms and deduplicates interrupt-ID resume. Core checks interaction URL origins before publishing pending state and gates development trace text by live labels and the declared trace destination. `@galaxie/models/mock` supplies a deterministic test provider. `@galaxie/models/webllm` adds a lazy WebLLM 0.2.86 worker provider with FIFO serialization, reset per request, cancellation, final-only usage, schema decoding and provider-level structured output, commit-pinned assets with SRI, content-free progress and typed errors, and a page-side device report. Twelve graph cases compare native Node, galaxie on Node and Chromium, alongside dual-lane policy, lifecycle, budget and tracing tests. See the [conformance guide](tests/conformance/README.md) and [M1 coverage map](docs/system-design.md#9-security-baseline-map). Packages remain private and unpublished. WebLLM loading, streaming, cancellation and schema wiring are tested with fakes only; the real-device run, prefill abort latency, page/worker adapter match and KV-cache reuse cost remain unmeasured. Worker failure or device loss leaves the selected provider failing `unavailable`, without fallback; the host recovers with a new handle, model and runtime. Hosts bundle one inference worker per runtime and may declare `structured-output` for routing. SRI covers config, library and tokenizer, not weight shards; host records must pin an immutable weight revision. Only the worker needs model-download hosts and WASM CSP directives; see [model integration](docs/system-design.md#84-a-model-call). `@galaxie/models/builtin-ai` adds a page-only Chrome Prompt API provider with a fresh session per call, streaming, cancellation and provider-level schema output through `responseConstraint`, omitting the schema from input. Hosts configure input/output languages and register destination `in-browser`, zero pricing, features `['streaming', 'cancellation', 'structured-output']` and the role's languages. Calls need `available` and never download. Use `checkBuiltInAI` to check readiness and `prepareBuiltInAI` from an intentional download click, with content-free progress. Typed reasons distinguish missing API, unsupported languages, required download or activation, failed download and denied browser access. It reports no usage, so routing charges the reservation; `maxTokens` and temperature have no effect. The model identity cannot be pinned and replies vary. Only a fake `LanguageModel` ran on Node and Chromium, with any existing global saved and restored. The M2 exit slice covers real-device verification, stable/beta smoke tests and session-creation cost; the router probes readiness before selection, without retrying a dispatched call on another provider. The router now supports host availability and download hooks, cached-before-download ordering for ADR-ordered routes, shared download decisions, optional site-storage `persist()`, per-call feature requirements and class-change notices through `snapshot.routes[role].changedFrom`. Routed `withStructuredOutput` forwards constrained decoding and validates replies with fixed errors. `RuntimeOptions.outputSafety` adds a host hook for routed reply text and tool-call arguments, checked before non-streaming return and before each growing streamed chunk, with one final check. Blocks fail `denied`; hook failures fail closed with `unavailable`, fixed errors and content-free diagnostics and span outcomes. Without a hook, core reports `output_safety_unset` once per routed instance. The host owns the hook's handling of reply text; earlier allowed chunks cannot be retracted, and direct models, tool outputs, capability results and other display callbacks remain outside this check. Mock-provider tests cover the LangGraph `messages` stream on Node and Chromium. `checkWebLLMModel` reports cached weights, not a loaded engine; WebLLM must still load before prepare until lazy host construction ships. The Prompt API reports no byte size, a known gap against ADR-0006 decision 5; hosts must state that the browser manages the download and its size is not reported. Remote providers, download-consent UI, provider caps from the router and durable storage remain unimplemented.
>
> `@galaxie/react` adds a typed registry, `useAgentSnapshot`, `AgentSurface` and unstyled Quiz, WritingPrompt, Feedback and Progress entries. Pass `ui: registry.bindings({ surfaces })` to `runtime.create` so core checks required UI, pending surfaces and allowed actions and payloads. The registry validates props and declared URL origins; the surface uses render-time identity and duplicate guards, with no lifecycle ownership. Model text renders only as React text. Drafts reset on remount and are not persisted. Chromium tests include Strict Mode and a real LangGraph resume. See the [React wiring sketch](docs/system-design.md#4-packages-and-dependency-rules) for the API and URL-policy limits.

The private workspace package [`@galaxie/example-english-tutor`](examples/english-tutor) runs the lesson → quiz → writing → Feedback → save → Progress flow with mocks on Node and headless Chromium. It commits one quiz and its key before pausing and grades deterministically for local practice only. WritingPrompt marks sentences `private-user`; core applies bound payload-schema labels before resume, so the default policy keeps review in-browser. Run output is exactly `{ lessonId, score, total, saved }`, and Quiz props omit the key. Feedback shows the correct option labels after grading. Raw `stream` events include graph state and the answer key; hosts must not render them as display data. This projection covers run output and interaction props only.

The tutor checkpointer contains the sentence and key: keep it on the device, scoped to the learner and session (as the default in-memory saver is). The host must derive the learner from trusted context in `progress.save@1` and authorize access to the lesson before writing; the agent sends only `{ lessonId, score, total }`. The example host, CSP and AT-04 network capture are deferred to slice 7; reload restore and draft persistence to M3; real providers and devices to the exit slice. Optional model-generated quiz explanations and rubric quality evaluation are outside this slice.

Routing, labels, consent and model budgets cover calls through `host.langchain.chatModel(role)`; trusted agent code holding a model instance can bypass them (ADR-0002). The router's `maxTokens` reserves budget: a call can use more, and an actual-usage overrun fails the run after that call returns. WebLLM separately sends its own `maxTokens` as the per-request output limit `max_tokens` (default 1024); the router does not pass its reservation as that limit. `getCredential` hands credentials to page code per call. An XSS or malicious dependency on the origin can read them; hosts should return short-lived, host-proxy-scoped tokens rather than long-lived provider keys (ADR-0012).

## Intended use and disclaimer

galaxie is experimental, pre-release software, provided "as is", without warranty of any kind. Sections 15 to 17 of the [AGPL](LICENSE) (disclaimer of warranty and limitation of liability) apply.

galaxie is not designed, tested or certified for high-risk or regulated uses, including:

- moving money: payments, transfers, trading or lending;
- decisions about people's credit, insurance, employment, admission or official grades;
- core systems of banks, insurers and other financial institutions;
- medical diagnosis or treatment, and safety-critical control.

If you use galaxie in such a context, you do so at your own risk. You are responsible for your own security review and for compliance with the rules of your sector.

Language models make mistakes. galaxie validates the shape of their output, not whether it is true, so keep a person in the loop for decisions that matter.

No test suite or review proves that software is secure. The known limits are listed in [brief §9.9](docs/galaxie-project-brief.md#99-limits-to-state-plainly) and [ADR-0012](docs/adr/0012-security-baseline.md).

## Documentation

- [Project brief](docs/galaxie-project-brief.md): scope, architecture, security model, roadmap and acceptance tests.
- [Framework overview](docs/framework-overview.md): role, audiences and the roadmap at a glance.
- [Architecture decision records](docs/adr/README.md): one file per decision.
- [System design](docs/system-design.md): components, packages, contracts and runtime flows.

## Roadmap

| Milestone | Focus |
| --- | --- |
| M1 | Headless host, adapter, capability broker, security skeleton, the parity conformance suite and OpenTelemetry spans |
| M2 | Local models and the English Tutor vertical slice |
| M3 | Durable interaction and recovery |
| M4 | Remote integration, reuse and the MVP release gate |

Spikes run when a milestone needs their answer: local inference and the UI path before M2, remote providers and MCP before M4. Details are in [brief §16](docs/galaxie-project-brief.md#16-roadmap).

## Development

You need Node.js 24 and pnpm 11 (through Corepack). Run `pnpm install`, then `pnpm check`, which runs every check CI runs. The toolchain is described in [system design §10](docs/system-design.md#10-toolchain).

## License

galaxie is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). Commercial use is allowed under the terms of the AGPL.

Using galaxie in a closed-source or proprietary product requires a [commercial license](COMMERCIAL-LICENSE.md).

## Contributing

Code contributions are not accepted yet.
