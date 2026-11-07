# galaxie

galaxie lets web apps run AI agents inside a web page, on the user's own device, with no agent backend. Each agent has an identity, a lifecycle, permissions, a place in the UI and a way to recover after a reload. Your app keeps its own backend, APIs and databases.

**Start here:** [Run the local English-tutor example](#try-it) with a scripted mock model, no model download and reload recovery.

Choose inference per model role under the app's policy: **local in the browser** with WebLLM, Transformers.js or Chrome Built-in AI; **partly local** by mixing local roles with roles using endpoints; or through a **backend or user endpoint** using an OpenAI-compatible provider.

> **Status: experimental and pre-release.** The packages are not published to npm yet, and most testing uses mock and fake models. Read the [known limits](docs/unsupported.md), [project status](docs/status.md) and [Intended use and disclaimer](#intended-use-and-disclaimer) before you build on it.

## Why

Most agent frameworks assume a server: a process, a container, a queue and an API key. For many web apps that is more than the job needs. An English tutor, a school Q&A bot, a customer-care assistant or a search over public documents can run on the user's device, which keeps the user's text on that device and removes the agent infrastructure.

The browser has no built-in answer for the hard parts: which model may see which data, what an agent may do, what happens after a reload or a double click, and how to show the agent's work in the app's own UI. galaxie supplies those parts.

## What you get

- **Your agent code, unchanged.** Write agents in a framework you already use. The goal is parity: an agent should behave in the browser as it does natively on a server. See [supported frameworks](#supported-frameworks).
- **Model routing.** Pick a model per role from local models in the browser (WebGPU), Chrome's built-in AI, a model server on the user's machine, or an OpenAI-compatible endpoint, under a policy the app sets.
- **A capability broker.** An agent can only do what the host app grants it. Everything else is denied by default, and data labels stop private text from reaching an endpoint that policy does not allow.
- **UI through your own components.** The agent drives a region of the page through a typed component registry. The host app owns the DOM, and model text renders as plain text.
- **Recovery.** A reload, a second tab or a double click does not repeat a side effect or lose a pending answer. State lives in IndexedDB, scoped to the user.
- **Budgets and tracing.** Limits on steps, tool calls, time, tokens and cost, plus OpenTelemetry spans that tools such as Langfuse can display.
- **A written security baseline** for every path the SDK controls, with its known limits stated in the [security review](docs/security-review.md).

## Supported frameworks

| Framework | How it runs | Notes |
| --- | --- | --- |
| LangGraph.js | Directly in the page | The reference adapter, checked against native runs on Node and Chromium |
| LangGraph (Python), pydantic-ai, DSPy | In a Worker through Pyodide | Routing, credentials and policy stay in JavaScript |
| Google ADK (JavaScript) | Directly in the page | Sequential, parallel, loop and LLM agents |
| Google ADK (Python) | In a Worker through Pyodide | Same agent shapes |
| Google ADK (Go) | Compiled to WebAssembly, in a Worker | Same agent shapes |

Each adapter lists what it does not support in the [unsupported-features list](docs/unsupported.md).

## Supported models

| Provider | What it is |
| --- | --- |
| WebLLM | Models on WebGPU, in a Worker |
| Transformers.js | ONNX chat models, in a Worker |
| Chrome Built-in AI | The browser's Prompt API |
| OpenAI-compatible | A host proxy or an endpoint the user chooses |
| Mock | A deterministic provider for tests |

## Project status

See [the detailed project status](docs/status.md) for implemented behavior, verification and unmeasured paths. Testing is mostly with mocks; the packages are not published to npm yet and carry no stability promise. The [MVP exit record](docs/mvp-exit-record.md) records acceptance evidence and gaps, and the [unsupported-features list](docs/unsupported.md) records known limits and unverified paths.

## Try it

You need Node.js 24 and pnpm 11 (through Corepack).

```sh
pnpm install
pnpm --filter @galaxie/example-host-local exec vite build --mode mock
pnpm --filter @galaxie/example-host-local exec vite preview --mode mock --host 127.0.0.1
```

This serves a local English-tutor host with a scripted mock model, so nothing is downloaded: a lesson, a quiz, a writing prompt and feedback, with reload recovery. Without `--mode mock` the host asks the user to download a real model, which needs a WebGPU device. The other examples:

- [`examples/host-remote`](examples/host-remote/README.md): the same tutor with a remote quiz model and confirmed saves.
- [`examples/rag-browser`](examples/rag-browser/README.md): retrieval built in the browser, with cited answers. `pnpm --filter @galaxie/example-rag-browser dev:mock` serves it with mock models.
- [`examples/mcp-server`](examples/mcp-server/README.md): a reference MCP server used by the tests.

`pnpm check` runs every check that CI runs, including the Go and Python lanes, so it also needs a Go toolchain and Python with `uv`. The [toolchain section](docs/system-design.md#10-toolchain) describes the TypeScript tooling.

## Repository map

| Package | Purpose |
| --- | --- |
| [`@galaxie/core`](packages/core/README.md) | Runtime, lifecycle, capability broker, model router, budgets, tracing |
| [`@galaxie/models`](packages/models/README.md) | Model providers |
| [`@galaxie/react`](packages/react/README.md) | Typed component registry, snapshot hook and headless components |
| [`@galaxie/storage-indexeddb`](packages/storage-indexeddb/README.md) | Checkpoints, recovery journal and session export in IndexedDB |
| [`@galaxie/tools-mcp`](packages/tools-mcp/README.md) | MCP client that binds allowlisted tools as capabilities |
| [`@galaxie/adapter-kit`](packages/adapter-kit/README.md) | Shared internal adapter translation and bridge helpers |
| [`@galaxie/adapter-langgraph`](packages/adapter-langgraph/README.md) | LangGraph.js adapter |
| [`@galaxie/adapter-pyodide`](packages/adapter-pyodide/README.md) | Python frameworks through Pyodide |
| [`@galaxie/adapter-adk`](packages/adapter-adk/README.md) | Google ADK (JavaScript) adapter |
| [`@galaxie/adapter-go`](packages/adapter-go/README.md) | Google ADK (Go) through WebAssembly |
| [`@galaxie/eslint-plugin`](packages/eslint-plugin/README.md) | Lint rules that flag direct platform access in agent code |

## Documentation

- [Host integration guide](docs/guides/host-integration.md): CSP, model hosting, storage, ownership, logout, confirmations and proxies.
- [Development tracing guide](docs/guides/tracing.md): spans and exporting through a collector.
- [System design](docs/system-design.md): components, contracts and runtime flows.
- [Architecture decision records](docs/adr/README.md): one file per decision.
- [Project brief](docs/galaxie-project-brief.md): scope, security model, roadmap and acceptance tests.
- [Framework overview](docs/framework-overview.md): the role of the project at a glance.
- [Security review](docs/security-review.md): controls, test evidence and residual risks.
- [Tested device matrix](docs/device-matrix.md): what has run where.
- [AI-facing index](llms.txt): a short map for coding assistants.

## Intended use and disclaimer

galaxie is experimental, pre-release software, provided "as is", without warranty of any kind. Sections 7 and 8 of the [Apache License 2.0](LICENSE) (disclaimer of warranty and limitation of liability) apply.

galaxie is not designed, tested or certified for high-risk or regulated uses, including:

- moving money: payments, transfers, trading or lending;
- decisions about people's credit, insurance, employment, admission or official grades;
- core systems of banks, insurers and other financial institutions;
- medical diagnosis or treatment, and safety-critical control.

If you use galaxie in such a context, you do so at your own risk. You are responsible for your own security review and for compliance with the rules of your sector.

Language models make mistakes. galaxie validates the shape of their output, not whether it is true, so keep a person in the loop for decisions that matter.

No test suite or review proves that software is secure. The known limits are listed in [brief §9.9](docs/galaxie-project-brief.md#99-limits-to-state-plainly) and [ADR-0012](docs/adr/0012-security-baseline.md).

## License

galaxie is licensed under the [Apache License 2.0](LICENSE) ([ADR-0024](docs/adr/0024-apache-2-0-license-and-dco.md)). Use in open-source and closed-source products is allowed under its terms. See [NOTICE](NOTICE).

## Contributing

Outside contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/): sign off each commit with `git commit -s`. No contributor license agreement is required. Run `pnpm check` before you open a pull request, and read [`AGENTS.md`](AGENTS.md) for the repository rules.
