# ADK JavaScript

<!-- galaxie:cite path="packages/adapter-adk/AGENTS.md" heading="Never" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
Do not import ADK subpaths or another executor adapter. Preserve CSP and Trusted
Types; do not add `unsafe-eval` or direct network access from a run.

<!-- galaxie:cite path="packages/adapter-adk/AGENTS.md" heading="Agent shapes" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
<!-- galaxie:summary:start -->
Use host-routed `LlmAgent`, `SequentialAgent`, `ParallelAgent` and `LoopAgent`
trees with distinct names; `subgraphs` is false. Pause only in the first child
at every sequence step or a transfer-linked LlmAgent chain. Parallel trees,
loops and later sequence children refuse pauses. AgentTool and Workflow remain
refused. Use host capability tools and fixed same-host toolsets.
<!-- galaxie:summary:end -->

Build fresh trees with `host.adk.llm(role)` in the entry factory, or opt into exact
declared-role strings with `defineAdkEntry({ agent, roleStrings: true })`.
Use exported `adkToolset(host, tools)` only for fixed same-host capability tools;
foreign models, dynamic/foreign toolsets, built-ins, planners and code executors
remain refused. Never lift a refusal to make a project run.

The host must retain jitless Zod initialization and ADK's content-capture build
define. See the
[adapter](https://github.com/vinhnxv/galaxie/blob/main/packages/adapter-adk/README.md)
for the measured host setup, streaming and persistence limits.
