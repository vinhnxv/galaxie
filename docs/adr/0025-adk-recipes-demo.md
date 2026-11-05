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
5. Put loan approval in the last child's confirmation tool on ADK Python. Python and Go allow this position; JavaScript permits a pause only in the first child. Bind finalization as a `retry: 'none'` write requiring host confirmation. Derive displayed decisions from confirmation state or receipts, never model text. Durable replay evidence belongs with the later loan implementation.
6. Replace search and storage with narrow, schema-validated capabilities over bounded synthetic fixtures. News is untrusted tool output. Application documents, internal business data and decisions carry `private-user`; fixture market news carries `public`. Finalization records stay in host memory in the scaffold. Pricing is a pure read. Only notices were read upstream for this implementation, so the scaffold's documented pricing tiers are synthetic, not a claimed port of upstream lending logic.
7. Build the Go recipe module with the existing locked build helper when its source and the local toolchain exist. Include verified glue and pass the module's byte length and SHA-256 to the adapter. Missing tools or sources make that lane unavailable while the host still builds. Python assets similarly require the local ADK wheel inventory and recipe sources; do not download them during the build.
8. Any XML tool-call parser and split-decoder ONNX record support is separate provider work, verified with a fake runtime before model pinning. Local-model wiring consumes reviewed pinned records only afterward. It must retain consent, data policy and the prohibition on fallback after dispatch.

The script, worker, connection and Trusted Types policies retain the existing strict mock-host values. This decision introduces no adapter or core contract change.

### Recipe shape changes

| Recipe | Refused or unavailable shape | Intended browser rewrite |
| --- | --- | --- |
| Financial advisor (TypeScript, Python and Go references) | `AgentTool` specialists are refused by all three adapters | Four specialists in sequence; search is a capability; JavaScript and Go demonstrations |
| LLM auditor (Python) | Grounding and edit-mark callbacks depend on genai types outside the supported Python authoring surface | Critic then reviser; fixture search; omit and document both callbacks |
| Small-business loan (Python) | `AgentTool`, `App`, planner, custom Gemini model, Firestore and GCS | Extraction, underwriting, pricing and decision in sequence; fixture reads and host-confirmed finalization |
| Safety plugins (Python) | Plugins are refused; Model Armor needs a cloud project | No rewrite. The existing host output-safety hook owns this layer |

## Alternatives considered

- Add another mode to the retrieval example: this mixes unrelated fixtures and tests into an already large host.
- Preserve conversational `AgentTool` delegation: refused at prepare by the current adapters.
- Use real financial news, applicants or cloud services: unnecessary for browser execution evidence and incompatible with the fixture-only lane.
- Implement provider parsing or model downloads in the scaffold: separate work with separate proof obligations.

## Consequences

The initial host has no agents or runnable recipe picker. Mock mode lists a deterministic in-browser model; default mode lists none. Python and Go preparation plumbing can report unavailable without breaking the build. The broader demonstrations remain prospective until their tests exist. No real model or device measurements are claimed.

## Verification

The scaffold requires the license and document checks, both TypeScript checks, Biome, dependency-boundary tests, fixture capability tests and a mock Vite build. A real retained notice in `disclaimer.ts` proves the SPDX-first layout works with the unchanged license checker. Node and Chromium tests check bounds, fixed failures, pricing boundaries, labels, confirmation policy, provider gating, exact mock CSP and Trusted Types URL validation.

Subsequent agent work needs scripted Node and Chromium runs for sequence, checked streams and state handoff. The loan work additionally needs approve, deny, paused reload and write-receipt replay evidence. Go needs native-versus-browser scripted comparisons. Documentation must record every rewrite and refusal. Provider work needs parser and split-export fake-runtime tests; model wiring requires reviewed pins and consent tests. Real-device demonstrations remain separate from these checks. This ADR stays Proposed.
