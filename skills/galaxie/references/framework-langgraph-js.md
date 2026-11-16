# LangGraph JavaScript

<!-- galaxie:cite path="packages/adapter-langgraph/AGENTS.md" heading="Never" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
Never construct an agent-held provider to bypass routing, depend on implicit
async context under the browser shim, or expose content/credentials in generated
errors or instrumentation. Do not import Node `AsyncLocalStorage` in the app's
browser executor.

<!-- galaxie:cite path="packages/adapter-langgraph/README.md" heading="Minimal model-free graph" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
<!-- galaxie:summary:start -->
Use native LangGraph through `@langchain/langgraph/web`, compile with
`host.langchain.checkpointer()`, and call `host.langchain.chatModel(role)`.
Pass the complete node config to model calls and `requestInteraction`, including
after an await. Keep the runtime alive until host teardown, then dispose it.
<!-- galaxie:summary:end -->

For capability calls pass node config and keep call order deterministic for
recovery. Put side effects after interrupts. Ask questions before fan-out or
serialize interrupting branches: parallel interrupts remain refused. Use explicit
`requestInteraction` gates instead of compiled static breakpoints; raw
`NodeInterrupt`/`GraphInterrupt` is not a supported resume replacement. Several
strict four-field requests in one top-level node publish one at a time; repeated
child-graph pauses, later-ordinal surfaces and repeated ID-less requests remain
refused. See the
[adapter guidance](https://github.com/vinhnxv/galaxie/blob/main/packages/adapter-langgraph/AGENTS.md)
and [request limits](https://github.com/vinhnxv/galaxie/blob/main/packages/adapter-langgraph/README.md#several-requests-in-one-node).
