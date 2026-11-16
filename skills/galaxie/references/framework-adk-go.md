# ADK Go

<!-- galaxie:cite path="packages/adapter-go/AGENTS.md" heading="Never" sha256="cecea527d8ccf4ad2571b92d9fa429760e86efc7f7e3034632d75a2ac5576de5" -->
Preserve CSP and Trusted Types; never add `unsafe-eval` or direct run network
access. Do not mix executor adapters or bypass the host's router and broker.

<!-- galaxie:cite path="packages/adapter-go/README.md" heading="Authoring surface" sha256="ff0b4eca267580ca89f8bf12b59eef859c9ea7ad5bb40228dc09d0d7d7022a52" -->
<!-- galaxie:summary:start -->
Build trees with galaxie's Go constructors: LlmAgent, SequentialAgent,
ParallelAgent and bounded LoopAgent, with Model(role) and CapabilityTool.
Trees deeper than 16, raw ADK agents/models/tools and AgentTool are refused;
`subgraphs` is false. Use only fixed capability Toolsets from the current build.
<!-- galaxie:summary:end -->

<!-- galaxie:cite path="packages/adapter-go/README.md" heading="Interactions" sha256="c217f8a241604df7cbcd3e6385be3dc6f3ecd3276e8a83fc5488c720178aeb3b" -->
A pause may resume in a transfer target or the last child of a sequence. Pauses
inside a ParallelAgent, LoopAgent or earlier sequence child remain refused, as
does confirmation beside a long-running call. Supply Interaction/Resume hooks
for pausing tools. Do not infer nested checkpoint namespaces from tree structure.

Keep Worker wasm length/SHA-256 verification and the reviewed Worker URL policy.
Use the generated `GO.md` for editing and the Go toolchain requirement. The stubs
catch accidental egress; trusted Go can reach `syscall/js`, so the Worker is not
an isolation boundary. See the
[adapter](https://github.com/vinhnxv/galaxie/blob/main/packages/adapter-go/README.md).
