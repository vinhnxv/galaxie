# ADR-0025: ADK recipe demonstrations through a separate browser host

- **Status:** Proposed
- **Date:** 2026-11-05
- **Related:** ADR-0012, ADR-0016, ADR-0020, ADR-0021, ADR-0022, ADR-0023, ADR-0024

## Context

The Apache-2.0 google/adk-recipes repository contains cloud-oriented examples. A browser demonstration can preserve their purpose while replacing cloud tools with host capabilities. The upstream reference is commit `1e5ed1a5713b739ff8ba58b39454c02bf8bad118`; [attribution](../../examples/adk-recipes/ATTRIBUTION.md) records inspected notices. galaxie is not affiliated with or endorsed by Google.

These are synthetic demonstrations, not financial advice or tools for real lending decisions. They establish neither answer quality nor model robustness.

## Decision

1. Use a separate `examples/adk-recipes` host. Keep the existing adapters, executor goldens, compatibility matrices and dependency inventories unchanged.
2. Rewrite recipe structures using each adapter's authoring surface. Do not vendor upstream deployment scaffolding, credentials or lockfiles. Retain each reused file's Apache notice below galaxie's SPDX header and state the changes. Display the financial recipe's disclaimer verbatim.
3. Begin with deterministic mock and scripted models. Default mode offers no provider until its prerequisites exist. Do not import model records before local-model wiring is implemented.
4. Use fixed-order `SequentialAgent` trees with `outputKey` state. Transfers are supported but depend on model routing; the fixed sequence deliberately loses the financial coordinator's conversational delegation.
5. Put loan approval in the last child's confirmation tool on ADK Python. Python and Go allow this position; JavaScript permits a pause only in the first child. Bind finalization as a `retry: 'none'` write requiring host confirmation. Derive displayed decisions from confirmation state or receipts, never model text. The loan tests cover restored pauses and successful write-receipt replay without repeating the binding.
6. Replace search and storage with narrow, schema-validated capabilities over bounded synthetic fixtures. News is untrusted tool output. Application documents, internal business data and decisions carry `private-user`; fixture market news carries `public`. Finalization records stay in host memory; scoped checkpoints and the recovery journal retain the paused run and confirmed write receipt. Pricing is a pure read. Only the upstream pricing notices were inspected for the host pricing function, so the host's documented pricing tiers are synthetic, not a claimed port of upstream lending logic.
7. Build the Go recipe module with the existing locked build helper when its source and the local toolchain exist. Include verified glue and pass the module's byte length and SHA-256 to the adapter. Missing tools or sources make that lane unavailable while the host still builds. Python assets similarly require the local ADK wheel inventory and recipe sources; do not download them during the build.
8. Any XML tool-call parser and split-decoder ONNX record support is separate provider work, verified with a fake runtime before model pinning. Local-model wiring consumes reviewed pinned records only afterward. It must retain consent, data policy and the prohibition on fallback after dispatch.

The script, worker, connection and Trusted Types policies retain the existing strict mock-host values. This decision introduces no adapter or core contract change.

### Recipe shape changes

| Recipe | Refused or unavailable shape | Browser rewrite |
| --- | --- | --- |
| Financial advisor (TypeScript, Python and Go references) | `AgentTool` specialists are refused by all three adapters | Four specialists in sequence; search is a capability; JavaScript and Go demonstrations |
| LLM auditor (Python) | Grounding and edit-mark callbacks depend on genai types outside the supported Python authoring surface | Critic then reviser; fixture search; omit and document both callbacks |
| Small-business loan (Python) | `AgentTool`, `App`, planner, custom Gemini model, Firestore and GCS | Extraction, underwriting, pricing and decision in sequence; fixture reads and host-confirmed finalization |
| Safety plugins (Python) | Plugins are refused; Model Armor needs a cloud project | No rewrite. The existing host output-safety hook owns this layer |

## Alternatives considered

- Add another mode to the retrieval example: this mixes unrelated fixtures and tests into an already large host.
- Preserve conversational `AgentTool` delegation: refused at prepare by the current adapters.
- Use real financial news, applicants or cloud services: unnecessary for browser execution evidence and incompatible with the fixture-only lane.
- Implement provider parsing or model downloads in the recipe host: separate work with separate proof obligations.

## Consequences

The host now runs four recipe choices with deterministic scripted models: financial advisor on JavaScript and Go, and auditor and loan on Python. Default mode offers no model provider. The registry constructs only the chosen executor for each document; switching aborts and disposes before navigating to another recipe. Missing Go or Python prerequisites disable those entries without failing the Vite build. Financial output follows the verbatim disclaimer and all model text renders through React text nodes. No real model or device measurements are claimed.

Loan approval uses the bound React surface, followed by a distinct host broker confirmation for finalization. The outcome display comes from pending confirmation arguments or the host receipt through `loanOutcome`; it omits decision-agent prose and leaves text-only completion undecided. Scoped IndexedDB checkpoints, recovery and fenced Web Lock ownership support pause reload. Start over settles the run and deletes its checkpoint and recovery records. Decision records are synthetic host-memory state, not a lending backend.

## Verification

The recipe checks use authored scripted replies through real adapters, the router and the capability broker. Existing Node and headless Chromium suites exercise sequence, checked streams, state handoff, bounds, fixed failures, pricing boundaries, labels, confirmation policy, provider gating, exact mock CSP and Trusted Types URL validation. The retained notice in `disclaimer.ts` exercises the SPDX-first layout with the license checker.

| Scripted evidence | Assertions and limits | Test sources |
| --- | --- | --- |
| JavaScript financial pipeline | Four ordered specialists and four output keys; empty findings, blocked chunks, step limits and an injected-result canary; no financial-quality or model-robustness inference | [Node](../../examples/adk-recipes/test/financial-js.node.test.ts), [Chromium](../../examples/adk-recipes/test/financial-js-browser.node.test.ts) |
| Go financial pipeline | Same final reply and four state values as JavaScript for fixture-backed and empty searches; real wasm, scripted models; existing 48 MiB ceiling | [Node comparison](../../examples/adk-recipes/test/financial-go.node.test.ts), [native Go](../../go/recipes/financial/agent_test.go) |
| Python auditor | Correction, empty/denied search and cancellation through verified cached Pyodide wheels | [Auditor](../../examples/adk-recipes/test/adk-python-llm-auditor.node.test.ts) |
| Python loan | Approval finalizes once; denial and text-only completion make zero finalize writes; stale/invalid submissions, fresh-Worker restore and successful receipt replay | [Loan](../../examples/adk-recipes/test/adk-python-loan.node.test.ts), [restore](../../examples/adk-recipes/test/adk-python-loan-restore.node.test.ts), [Chromium reload](../../examples/adk-recipes/test/adk-python-loan-browser.node.test.ts) |
| Rendered host | Picker runs, disclaimer order, model destinations, blocked-output display, free-text unverifiable handling, lazy Worker creation and abort-before-switch; loan approval/denial, pause reload, Start over and undecided text-only completion | [Host](../../examples/adk-recipes/test/host-browser.node.test.ts), [Python host](../../examples/adk-recipes/test/adk-python-host-browser.node.test.ts) |

The rendered host tests record CSP and Trusted Types violations and reject requests outside the preview origin. Python tests use the existing verified-wheel gate and their filenames contain `adk-python` for the corresponding CI shard; Go uses its existing toolchain gate. These checks do not download model weights or contact a third-party endpoint. The [example guide](../../examples/adk-recipes/README.md) and [unsupported list](../unsupported.md#adk-recipe-example) record the rewrite deltas, refusals, synthetic pricing and recovery limits.

On 2026-11-05, a maintainer-machine scripted run passed all 100 example tests in 17 files with all 10 package `dist` directories temporarily removed; the full TypeScript check also passed before those directories were restored. The Go recipe build produced 30,005,637 wasm bytes, below the existing 48 MiB ceiling. The rendered JavaScript, Go and verified-wheel Python flows observed zero CSP or Trusted Types violations and zero off-origin requests, including loan approval, denial, paused reload and Start over. These are scripted orchestration and local build observations, with real Go and Pyodide runtimes but no real model or device-performance measurement.

Provider parser and split-export work remains separate, and model wiring requires reviewed pins and consent tests. No ONNX record is included here. Real-device demonstrations, inference quality, download performance, latency distributions and memory remain unmeasured. This ADR stays Proposed.
