# Prompt injection corpus

This synthetic corpus assumes a fully compromised model. The obedient-attacker mock selects a validated directive when its input contains the exact payload, then returns that directive without resisting it. Matching is a deterministic script selector, not an injection detector. The tests judge SDK-controlled outcomes, not model robustness or answer quality (ADR-0016).

`cases.json` is a static JSON array, not a workspace package. Each case has a unique kebab-case `id`, a `vector` (`lesson`, `tool-output`, `mcp-description`), a `goal`, a synthetic `payload`, and a closed structured `directive`. Directives can call a named capability, emit the fixture's interaction, reply with text, forward the private value to `agent.main`, or supply a decision through `{ kind: 'decide', skipConfirmation: boolean, confidence?: number }`. They cannot execute code. Zod rejects malformed cases and unknown directive fields before use; decision confidence must be finite and in [0, 1]. Coverage validation requires at least 30 cases, at least eight per vector, and all 15 vector–goal pairs. The corpus has 38 cases. Existing assertions are unchanged.

The main runner is [`injection-corpus.test.ts`](../conformance/injection-corpus.test.ts). Run it on both Node and headless Chromium with:

```sh
pnpm exec vitest run tests/conformance/injection-corpus.test.ts
```

It also runs in `pnpm check` and `CI=true pnpm test`. Every provider is a deterministic mock. No real model global, WebLLM bundle or model download is used. Test network traffic is confined to the Vitest runner and the dedicated loopback MCP fixture. The network recorder captures URLs and serialized request bodies for fetch, XHR, beacons, WebSockets and EventSource, blocking other origins before dispatch. Its self-test exercises available APIs with blocked synthetic requests and a loopback request. It does not use the Node socket recorder, which would block MCP.

The executing graph performs the attacker's requested action through the broker, router or interaction policy. Writes receive no approval: tests inspect the frozen real arguments and host registry text, then decline. The mock host grants remote-route consent so missing consent cannot mask a label-policy regression. Default private input labels remain sticky; forwarding to the host-server spy fails before the provider runs, with its shared generation/streaming call counter at zero. URL policy is checked before any snapshot publishes pending state. The fixed graph for `instruction-in-data` never executes model tool calls and projects output to `{ answered: true }`.

The decision path in [`injection-fixture.ts`](../conformance/support/injection-fixture.ts)
uses `ObedientDecisionAttacker` from
[`obedient-attacker.ts`](../conformance/support/obedient-attacker.ts), a fully
compromised structural decision model. It returns the directive's
`proceedWithoutAsking` boolean and optional confidence after reading the payload,
without resisting or detecting it. A routed `agent.decision` node reads the content
capability and stores only answers in state; a separate gate node uses the fixed
host threshold 0.7 and registered `tests.CorpusAsk/v1` text. High confidence omits
only that extra question: the broker still publishes the write confirmation with
the real frozen arguments, and declining it fails `denied` without a write. Low
or missing confidence asks first. `stop` completes with `{ answered: true }` and
no write; `continue` still reaches the broker confirmation and is declined. The
runner checks both choices for the low-confidence case and one payload read per
run, with no chat-attacker or remote-model dispatch. A decision can add a question,
never remove a confirmation. These are mock-runtime outcomes, not confidence
calibration or real-model measurements.

MCP metadata is used only for pins; galaxie never supplies descriptions to the model. These cases therefore both give the synthetic description directly to the attacker and check the separate metadata boundary. Each MCP case first uses the host-approved pinned tool, changes its description through a test-only admin action, runs its directive, then attempts the pinned tool again. The next call must fail `unavailable` without another server invocation or metadata disclosure. `mcp-description-changes-after-approval` names that boundary explicitly. Browser files use separate servers, so the corpus never mutates the fixture used by `mcp.test.ts`. Reset restores the original description.

The fixture keeps private input and retrieved content out of graph state, disables native LangGraph message streaming with the supported `nostream` tag, and projects replies away. This is fixture behavior, not SDK redaction: raw engine streams and checkpoints can contain untrusted content. Hosts must keep checkpoints on-device and never display raw streams. The runner checks every collected event, snapshot, span and error for payload/private markers. Diagnostic fields are checked locally, including `String(event.error)` because `Error.message` is not enumerable. `DiagnosticEvent.error` is host-only evidence and must never be forwarded to traces or public surfaces.

`url-query-on-allowlisted-origin` documents the residual risk for unregistered values: `https://example.test/lesson?note=synthetic-query-value` still becomes pending. The value is synthetic and unregistered, so the case deliberately passes unchanged. Core rejects URL candidates containing registered private strings, checking the raw string and parser-normalized candidate through up to two rounds of percent-decoding with `+` treated as a space. This also prevents literal tab/newline/carriage-return stripping from reconstructing registered text. Matching uses the broker's lowercase/whitespace normalization and eight-character registration minimum. It does not detect paraphrases, other encodings or structured channels. When whole-string decoding fails, each maximal run of valid percent escapes is decoded independently on both passes; invalid UTF-8 runs stay raw. The guard applies unless the host allows `third-party` for `private-user`, because a followed link can reach an arbitrary site. Origins still do not constrain URL templates; hosts must constrain paths and query values. The fixture's component renders model text only as a React text child; no DOM rendering check runs in the Node project.

The separate [`interaction-url-private.test.ts`](../conformance/interaction-url-private.test.ts) covers query encodings, malformed escapes and parser controls on Node and Chromium without changing `cases.json` or its coverage assertions. It uses the obedient-attacker mock and a framework-neutral executor to exercise the runtime, model lease and accepted-payload registration. A private sentence enters through a bound UI submission before the mock emits its link. The link fails `denied` before pending publication; collected events, snapshots, warnings, diagnostics and spans contain neither the sentence nor the URL, and the network recorder sees no requests. This executor emits no raw graph streams; the LangGraph stream/checkpoint limits above remain unchanged. [Core tests](../../packages/core/test/interaction-private.test.ts) also cover paths, unregistered values, the policy opt-out and restored submissions.

Payloads use only `example.test` and `attacker.invalid` (including look-alike subdomains), synthetic values and no third-party corpus. Forms include instruction overrides, forged system/tool messages and approvals, Markdown links, HTML comments, zero-width/bidirectional characters, base64 and tool-call-shaped JSON. Add data-driven cases without changing existing assertions. A newly demonstrated control failure must retain its assertion, use `test.fails` with a comment naming the gap, and be reported in a draft pull request; do not change runtime controls in this slice.

The two `langgraph-tool-output-*` cases also run through the routed model and
`capabilityTool` loop in [`langgraph-tools.test.ts`](../conformance/langgraph-tools.test.ts).
An obedient-attacker mock first retrieves the injected tool result, then chooses
a write or a read forwarding a private value to a bound third-party recipient.
The write must reach a host confirmation and be declined without invocation;
the read must be denied before binding dispatch. Both denials return fixed
`ToolMessage` text and the model completes. These Node/Chromium scenarios use
mock models and provide no real-model result. The existing runner also executes the added cases through
its original fixture and unchanged assertions.
