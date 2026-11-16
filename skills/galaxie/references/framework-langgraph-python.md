# LangGraph Python

<!-- galaxie:cite path="packages/adapter-pyodide/AGENTS.md" heading="Never" sha256="1f040593263e577ae8cbdc1bff6ea3ea0d5e3e177ea6d8c82b32e018ea5643e9" -->
Keep credentials, providers and policy in JavaScript. Do not expose credentials
to the Worker, import the JavaScript LangGraph adapter, relax CSP or copy spike
code. Keep byte checkpoints on the scoped host port; Python never accesses
IndexedDB directly.

<!-- galaxie:cite path="packages/adapter-pyodide/AGENTS.md" heading="Agent shapes" sha256="75d6011bcee9ee24953bebc940b76147d7d97dcb1862aa20981c88b3311a0d12" -->
<!-- galaxie:summary:start -->
Return a graph compiled with `galaxie.langgraph.checkpointer()`. Async text
models, checked streams, subgraphs and child-interrupt restore are supported.
Parallel/ID-less interrupts and static breakpoints remain refused. Native tool
calls, `bind_tools` and default structured output remain refused; use the
documented author-validated text protocol for model-chosen calls.
<!-- galaxie:summary:end -->

Pass complete node config to interactions. Preserve deterministic capability call
order for replay and keep terminal host failures uncaught. Route through the
Python galaxie proxies; do not add a provider client in Python. Durable restore
needs the scoped host byte-record port and matching recovery store. Python is
trusted and can import `js`; the Worker is not an isolation boundary.

Build and serve the generated runtime assets and wheels using the existing build
scripts; no Python/uv is needed for an unchanged prebuilt app. The adapter checks
third-party wheel hashes, while local wheels and agent sources are trusted build
outputs. See the
[adapter and text protocol](https://github.com/vinhnxv/galaxie/blob/main/packages/adapter-pyodide/README.md#langgraph-python-model-chosen-calls-through-text).
