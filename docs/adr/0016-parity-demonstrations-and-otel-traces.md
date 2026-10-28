# ADR-0016: Parity is the verdict, metrics are demonstrations, traces are OpenTelemetry spans

- **Status:** Accepted (founder decision, 2026-10-28)
- **Date:** 2026-10-28
- **Related:** brief §0.2, §14.4, §16.2, §16.3, §17 (AT-15, AT-36), §18; ADR-0001, ADR-0003, ADR-0005, ADR-0006, ADR-0012, ADR-0014, ADR-0017

## Context

Brief 0.2 judged galaxie by numbers. Before a Spike B bake-off, the founder was to freeze the reference devices, the eval datasets and the thresholds: a valid-quiz rate, a rubric score from a human reviewer, download size and latency. The M4 Go/Revise decision used the same numbers, and M1 could not start before every M0 spike had reported.

Two spikes ran on 2026-10-28, on one Mac. B0 loaded a 1.7B model on WebGPU, and a local English tutor ran a LangGraph.js agent on that model in Chrome. They showed that the numbers depend mostly on choices galaxie does not make:

- the model;
- how the provider produces structured output: with free-form JSON and one repair attempt, 13 of 49 lesson sections failed; with each section's JSON Schema enforced while decoding, none did;
- the prompts, tools and pipeline that the agent author designs.

A threshold on such numbers would judge the agent author's choices, not galaxie. Scoring the quality of answers, such as a tutor's lessons, needs domain rubrics and reviewers; that is the agent author's work.

What galaxie does own is whether an agent written with LangChain and LangGraph behaves in the browser as it does natively on a server. Developers will adopt galaxie only if their code keeps working.

During development, agent builders also need to see what a run did: the order of the steps, the model and tool calls, and where the time went. Tools such as Langfuse read OpenTelemetry traces sent over OTLP/HTTP [S46]. Brief 0.2 planned a local trace with redaction in M1 and deferred trace export to Phase 6.

## Decision

1. **The verdict on galaxie is parity.**
   - A conformance suite runs the same graphs, with a deterministic fake chat model, on Node and in Chrome. It compares stream events, final state, checkpoints, interrupts and resume, after normalizing generated IDs and timestamps.
   - A difference is fixed, or recorded in the compatibility matrix with its reason. One is known already: browsers have no `AsyncLocalStorage`, so some LangGraph.js APIs need `config` passed explicitly.
   - The suite is M1 work. It replaces the engine part of Spike A.
2. **Accuracy and system metrics are demonstrations.**
   - galaxie records them on named devices and publishes them with the setup that produced them: download size, warm-up, time to first token, latency percentiles, schema-valid and repair rates, restore time, memory and integration effort.
   - None of them is a pass/fail threshold, and nothing is frozen before a spike.
   - galaxie does not score the quality of answers.
3. **Engineering checks keep a fixed bar**, because they test galaxie's own code: parity, recovery in the fault-injection suite (100% of scripted cases), and no galaxie-attributed main-thread long task over 50 ms while inference runs (the ADR-0003 trigger).
4. **Traces are OpenTelemetry spans, from M1.**
   - `core` calls only the OpenTelemetry API, `@opentelemetry/api`. Until the host registers an OpenTelemetry SDK, those calls do nothing. galaxie ships no exporter, holds no tracing credentials and sends no telemetry of its own.
   - Each run produces one span tree: the run, then its graph nodes, model calls and capability calls.
   - Attributes follow the OpenTelemetry GenAI semantic conventions where one fits [S47]. Their status is Development, not stable, so galaxie records the revision it follows. Its own attributes start with `galaxie.`.
   - galaxie filters what it records, not what the exporter sends (ADR-0012 A4). By default, every attribute, event, exception and status message it records holds only allowlisted values; an error is recorded as its type and galaxie's error code, not its message. Prompts, model output and capability arguments need the host's development opt-in. Opted-in text then follows the data labels like any outbound call: the host declares the destination class of the system that finally receives the spans, and text whose labels allow only `in-browser` stays out whatever the declaration (ADR-0014). Credentials never appear.
   - The host registers the exporter. From a browser, spans go to a collector or proxy the host runs, which adds the Langfuse credentials; a Langfuse secret key never ships in a bundle.
5. **Spikes run when a milestone needs them.** M1 starts without them. Spike B (in-browser engine) and Spike C (UI path) run before M2, and Spike D (remote paths) before M4.

## Alternatives considered

- **Numeric thresholds frozen before a bake-off (brief 0.2).** Rejected: the numbers mostly measure the model and the agent author's design. A frozen threshold would fail galaxie for one model choice and pass it for another.
- **An LLM judge or a human rubric score as a release gate.** Rejected: it judges the agent's content, not the runtime. Agent authors can run their own evaluations on top of galaxie's traces.
- **A galaxie trace format with its own viewer and exporter.** Rejected: tracing tools already read OpenTelemetry; a custom format would need a converter for each tool.
- **galaxie exporting straight to Langfuse.** Rejected: the browser would hold a secret key, and galaxie would decide where data goes, which is the host's decision.
- **Finish every spike (M0) before M1.** Rejected by the founder: spike work was delaying the core runtime.

## Consequences

- `core` depends on the OpenTelemetry API package, and on no other OpenTelemetry package. Until now `core` had no runtime dependencies; system design §4 now names this one as the exception. Whether it is a peer dependency is settled with the M1 package setup; OpenTelemetry's own instrumentation packages declare it as one.
- The compatibility matrix becomes a release artifact. CI runs the conformance suite on Node and in a headless Chrome.
- Spike B compares engines on functional checks, including whether an engine enforces a JSON Schema while decoding, and records its numbers as demonstrations (ADR-0006).
- The Go/Revise decision rests on parity, the acceptance tests and the engineering checks. The demonstrations are published with it but do not decide it (brief §18).
- Spans become a new path off the device once the host registers an exporter. AT-36 tests the span tree, the allowlist on everything galaxie records, and the label rule against the declared trace destination.

## Verification

- M1: the conformance suite passes on Node and in Chrome, or each difference is in the compatibility matrix with its reason (AT-15).
- M1: with an in-memory exporter, a run produces the span tree of AT-36, including runs where a model call and a capability call fail. No span holds a credential or an error message. None holds a prompt, model output or capability argument without the opt-in, and with it, none holds text whose labels do not allow the declared trace destination. With no SDK registered, tracing makes no network request.
- M3: the conformance suite's persistence cases run again with the IndexedDB saver (ADR-0005).
- M4: the development tracing guide shows spans reaching Langfuse through a host collector.

[S46]: https://langfuse.com/integrations/native/opentelemetry
[S47]: https://github.com/open-telemetry/semantic-conventions-genai
