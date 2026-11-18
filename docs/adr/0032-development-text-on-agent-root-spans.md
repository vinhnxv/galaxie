# ADR-0032: Development text on agent root spans

- **Status:** Proposed
- **Date:** 2026-11-18
- **Related:** brief §14.4 and §17 (AT-36), [ADR-0012](0012-security-baseline.md), [ADR-0014](0014-data-labels-and-argument-shapes.md), [ADR-0016](0016-parity-demonstrations-and-otel-traces.md), `galaxie-d53.7`

## Context

In the MLflow 3.18.0 spike, each text mode produced six traces and one value per
scorer per trace. The usage scorer returned five tokens per trace, and chat text
presence followed the development opt-in. Trace-level request and response were
empty in both modes. The in-memory oracle confirmed that `invoke_agent` carried
neither input nor output, so evaluators that read trace-level fields could not
use them. See [mlflow-evaluation.json](../../spikes/llmops-trace-sinks/results/mlflow-evaluation.json)
`/variants/0` and `/variants/1`, and [gaps.json](../../spikes/llmops-trace-sinks/results/gaps.json)
`/5` (`mlflow-root-io`).

## Decision

Core owns the text on its `invoke_agent` span. Reuse `gen_ai.input.messages`
and `gen_ai.output.messages` from the existing development-text allowlist. Write
each as a JSON string containing a one-message array with a single `text` part.
The input message has role `user` and the output message has role `assistant`.
These represent the segment's agent invocation and reply. The pinned
[OpenTelemetry agent-span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/51a0f580f8a6ad804ca4de5e033683c6fbbe5906/docs/gen-ai/gen-ai-agent-spans.md#invoke-agent-internal-span)
already list both keys as opt-in for an internal agent invocation. The general
metadata allowlist gains no entries.

- The input candidate is the schema-validated, normalized start input when it
  is a nonempty string. It is eligible on success or when the initial segment
  pauses. Resumed segments omit input because their command carries a submission
  from the inbox. Each segment retains its own root.
- The output candidate is a nonempty string from the terminal executor `output`
  event that core accepts as success, including success after resume. Paused,
  failed and cancelled segments have no output candidate. Failed and cancelled
  segments omit both attributes. Core leaves structured values and raw stream
  data out. It never serializes an inbox or checkpoint, a pending interaction,
  an error, provider credentials or a capability envelope for root text.
- Both attributes are absent by default. With `RuntimeOptions.developmentTraceText`,
  write immediately before the root ends and after the segment's labels are
  known. For each candidate, use the live sticky run labels, including the
  existing `private-user` treatment of submitted text and restored data. Use
  `private-user` for an unlabelled start string and also for the reply because
  executor output has no independent schema classification. These trace-only
  labels supplement the live check without altering routing or run state.
  Apply `inBrowserOnly` and `labelsAllow` against that set. Any browser-only
  label suppresses text regardless of the declared class. Every label must allow
  the declared final recipient. For collector fan-out, the host declares the
  least-trusted destination in the pipeline, such as `third-party` when a host
  collector forwards to a hosted service.
- The admitted text is verbatim. Data selection and omission enforce ADR-0012
  A4. There is no generic text redaction, and credentials handled by galaxie
  stay outside the candidate path. Limit each complete encoded attribute to
  the smaller of 16 KiB and the configured `payloadBytes` limit, measured in
  UTF-8 after JSON escaping. Bound the candidate before encoding as well.
  Serialization failure or excess size omits the entire attribute. The trace
  limit leaves execution and its payload accounting unchanged.

The host collector owns any mapping from those attributes to backend request or
response fields. It uses only root attributes already admitted by core. Exporter
registration and tracing credentials stay with the host.

## Alternatives considered

- **Root attributes under the existing opt-in.** Chosen because core owns the
  invocation boundary and can apply the final live labels before handing the
  root to the host's exporter.
- **A separate text child span.** A child would need collector promotion to
  reach trace-level fields and would add a span for text with no operation or
  duration of its own.
- **Keep root text absent.** This preserves the measured usage and chat-text
  scorers. Evaluators that require the trace-level request or response would
  still lack those values. Copying the first and last chat spans would conflate
  a particular model call with the agent invocation.

## Consequences

The working default admits a bounded text-only slice. Structured invocations,
resume submissions and streamed partial output remain outside that slice.
Under the default `private-user` policy, an executor reply remains absent even
with trace text enabled. The core policy admits replies only where the host
already permits their labels to reach the final recipient. ADR-0012 continues
to govern the recorded content and the host's exporter.

## Verification

**Follow-up — Record gated development text on agent root spans.** Implement
core capture at the segment boundary and document the root scope of the two
existing keys. Extend AT-36 with a text-only fixture on Node and Chromium.
Assert the exact message shape and size boundary, default omission, allowed
destinations, text protected by browser-only or disallowed late labels,
unlabelled text, failure, cancellation, pauses and resume. Cover UTF-8 and JSON
escaping, credential canaries, and unchanged child spans and execution budgets.
Use an in-memory exporter to verify each root independently. Before claiming
backend support, verify that host collector readback populates trace-level
request and response for eligible text and leaves them empty when text is
omitted. Backend mapping of the proposed attributes, exporter limits and the
behavior of evaluators that consume these fields are unmeasured.
