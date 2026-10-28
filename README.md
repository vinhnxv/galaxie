# galaxie

A browser-first agent runtime SDK for web apps.

galaxie lets a web application host AI agents as first-class parts of the app. Each agent has an identity, state, a lifecycle, permissions, a UI region and a recovery story. Agent logic stays in the frameworks developers already use, such as LangGraph.js. The runtime is designed to add what the browser lacks:

- **Model routing:** local models in the browser (WebGPU), Chrome Built-in AI, or an OpenAI-compatible endpoint chosen by the app or the user, under a per-role policy.
- **A capability broker:** agents act only within the app's own permissions, deny-by-default.
- **UI through the app's own components:** the agent drives an assigned UI region; the host owns the DOM.
- **Recovery:** a reload, a second tab or a double click does not repeat a side effect or lose a pending answer.
- **A mandatory security baseline** on every path the SDK controls.

> **Status: design phase.** There is no package to install yet. This repository holds the project brief and the architecture decisions that the first milestones will implement.

## Documentation

- [Project brief](docs/galaxie-project-brief.md): scope, architecture, security model, roadmap and acceptance tests.
- [Framework overview](docs/framework-overview.md): role, audiences and the roadmap at a glance.
- [Architecture decision records](docs/adr/README.md): one file per decision.

## Roadmap

| Milestone | Focus |
| --- | --- |
| M0 | Feasibility spikes: engine and persistence, local inference, UI path, remote providers and MCP |
| M1 | Headless host, adapter, capability broker and security skeleton |
| M2 | Local models and the English Tutor vertical slice |
| M3 | Durable interaction and recovery |
| M4 | Remote integration, reuse and the MVP release gate |

Details are in [brief §16](docs/galaxie-project-brief.md#16-roadmap).

## License

galaxie is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). Commercial use is allowed under the terms of the AGPL.

Using galaxie in a closed-source or proprietary product requires a [commercial license](COMMERCIAL-LICENSE.md).

## Contributing

Code contributions are not accepted yet.
