# galaxie

A browser-first agent runtime SDK for web apps.

galaxie lets a web application host AI agents as first-class parts of the app. Each agent has an identity, state, a lifecycle, permissions, a UI region and a recovery story. Agent logic stays in the frameworks developers already use, such as LangGraph.js. The runtime is designed to add what the browser lacks:

- **Model routing:** local models in the browser (WebGPU), Chrome Built-in AI, or an OpenAI-compatible endpoint chosen by the app or the user, under a per-role policy.
- **A capability broker:** agents act only within the app's own permissions, deny-by-default.
- **UI through the app's own components:** the agent drives an assigned UI region; the host owns the DOM.
- **Recovery:** a reload, a second tab or a double click does not repeat a side effect or lose a pending answer.
- **A mandatory security baseline** on every path the SDK controls.

> **Status: design phase.** There is no package to install yet. This repository holds the project brief, the architecture decisions, the system design, and a toolchain skeleton whose only package, `packages/core`, contains draft contract types.

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
| M0 | Feasibility spikes: engine and persistence, local inference, UI path, remote providers and MCP |
| M1 | Headless host, adapter, capability broker and security skeleton |
| M2 | Local models and the English Tutor vertical slice |
| M3 | Durable interaction and recovery |
| M4 | Remote integration, reuse and the MVP release gate |

Details are in [brief §16](docs/galaxie-project-brief.md#16-roadmap).

## Development

You need Node.js 24 and pnpm 11 (through Corepack). Run `pnpm install`, then `pnpm check`, which runs every check CI runs. The toolchain is described in [system design §10](docs/system-design.md#10-toolchain).

## License

galaxie is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). Commercial use is allowed under the terms of the AGPL.

Using galaxie in a closed-source or proprietary product requires a [commercial license](COMMERCIAL-LICENSE.md).

## Contributing

Code contributions are not accepted yet.
