# ADR-0014: Run-level data labels and argument shapes

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §3.3, §9.6 (scenario 14), §9.7 A6, §17 (AT-04, AT-32); ADR-0006, ADR-0012

## Context

ADR-0006 sets destination classes per model role. An external review found two gaps:

- **Across roles.** In the tutor, the learner's sentence (step 9) enters graph state. A later call by another role (`quiz.generate`, allowed to go remote), a capability argument or a trace can carry it out of the browser, even though `tutor.feedback` itself is `local-only`.
- **Through allowed endpoints.** Host-defined destinations and URL templates do not stop an injected model from putting private text into an allowed search query, into a free-text field of a write, or into a remote prompt.

Full taint tracking through LLM output is not possible: model output depends on everything in its context. A conservative rule is needed that is simple enough to enforce and to test.

## Decision

- **Labels.** Schemas mark fields with a data label:
  - `public`: lesson content, catalog text;
  - `app`: application data read under the user's permissions;
  - `private-user`: the learner's own text or audio.

  Defaults:
  - a free-text field in a UI event is `private-user`;
  - an unlabelled capability output is `app`.
- **Run-level, sticky.**
  - When labelled data enters a run (UI events, capability outputs, input), the run gains that label.
  - Labels are never removed during the run.
  - To shed a label, the host starts a new run. The new run's input is labelled again, from its own schema.
- **Policy.** Host policy maps each label to the destination classes it may reach. The default maps `private-user` to `in-browser` only. Per-role policy (ADR-0006) can narrow this, never widen it.
- **Enforcement on SDK-controlled paths:**
  - **Model calls:** the provider's destination class must be allowed for every label the run carries. Otherwise the call is blocked, or needs consent if host policy allows that.
  - **Capability arguments.** Each string field in an input schema declares a shape: `id`, `enum`, `pattern` (with a bounded length) or `freeText`.
    - A `freeText` field follows the same label rule as a model call, using the capability's host-declared destination class.
    - IDs, enums, numbers, booleans and short bounded patterns pass. They are a low-bandwidth channel, and the docs say so.
  - **Verbatim-match guard:** as an extra check, outbound request bodies are scanned for registered `private-user` values above a minimum length.
  - **Traces** record only allowlisted fields (ADR-0012 A4).

## Alternatives considered

- **Per-role policy only.** Rejected: it does not cover data that moves between roles or into capabilities.
- **Field-level taint tracking through model output.** Rejected: once private data is in a model's context, every output must be treated as derived from it. That is exactly the run-level rule, with more machinery.
- **A classifier that detects private data in outbound text.** Not a primary control: it is probabilistic. It may be added as an extra layer.

## Consequences

- Some workflows need two runs. For example, a host that wants remote quiz generation after the writing step starts a new run.
- Capabilities must declare argument shapes and a destination class. A host binding without them is rejected at build time.
- Residual risks are documented:
  - paraphrased private data sent to an allowed destination;
  - the low-bandwidth structured-argument channel;
  - code that bypasses the SDK.

## Verification

- M1: router and broker unit tests for every label/class combination.
- M2: AT-04 network capture on the tutor slice.
- M4: AT-32 with injection-corpus cases that try to leak through allowed endpoints.
