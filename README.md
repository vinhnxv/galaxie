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

> **Status: M1 runtime slices 1–3.** The workspace includes instance and run lifecycles, cancellation, replayable in-memory events, a LangGraph.js adapter, a capability broker with grants and validation, sticky data labels and argument shapes, finite step/tool-call/wall-clock/payload/token/cost budgets, and allowlisted OpenTelemetry spans. The model router selects providers per role under destination allowlists, labels and consent, with per-call credentials and route snapshots. `@galaxie/models/mock` supplies a deterministic test provider. Seven existing graph cases retain native parity on Node and Chromium, alongside routing conformance tests. Packages remain private and unpublished. Real providers, availability probing, first-run download order, structured output through the router, provider token caps, durable storage and UI integration remain unimplemented.

Routing, labels, consent and model budgets cover calls through `host.langchain.chatModel(role)`; trusted agent code holding a model instance can bypass them (ADR-0002). `maxTokens` reserves budget rather than capping a provider: a call can use more, and an actual-usage overrun fails the run after that call returns. `getCredential` hands credentials to page code per call. An XSS or malicious dependency on the origin can read them; hosts should return short-lived, host-proxy-scoped tokens rather than long-lived provider keys (ADR-0012).

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
