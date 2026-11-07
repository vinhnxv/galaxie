---
title: Decision Model Measurement Spike
type: spike
date: 2026-11-07
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
origin:
  - docs/adr/0028-decision-model-role.md
  - docs/plans/2026-11-04-0809-feat-open-source-launch-and-architecture-backlog-plan.md
---

# Decision Model Measurement Spike

## Purpose and authority

This plan is written before any maintainer device run.
It follows [ADR-0028](../adr/0028-decision-model-role.md) and the decision-model spike
in the [launch backlog](2026-11-04-0809-feat-open-source-launch-and-architecture-backlog-plan.md).
The [isolated spike](../../spikes/decision-models/README.md) is a throwaway instrument.
No implementation is promoted to packages and no model is recommended by this task.

Results are demonstrations under [ADR-0016](../adr/0016-parity-demonstrations-and-otel-traces.md).
They are not framework pass/fail quality gates, security guarantees, or promises about
another host's questions, device, language, calibration or workload.
Functional observations establish only the behavior actually exercised.
The mock establishes harness evidence only, never model measurements.

## Device and browser profile

Before running, the maintainer records:

- Device model, OS/version, power mode, RAM and available GPU-memory tooling.
- Foreground Chrome version, user agent, flags and extensions.
- WebGPU presence, adapter vendor/device/architecture/description and all exposed limits.
- Device-memory hint and hardware concurrency; absent hints remain null.
- Page version and exact ORT version, dependency lockfile and model revisions.
- Cache state, network conditions, thermal/background workloads and chat-model setup.
- Any unavailable configuration or scripted-versus-normal-browser difference.

The export records browser/device API observations, not inferred physical specifications.
Additional device notes stay with the maintainer's demonstration record.
Managed LanguageModel identity cannot be pinned; browser version and availability must be retained.

## Question set and declared analysis

The [question generator](../../spikes/decision-models/scripts/build-questions.ts) uses seed 20261107.
It produces [200 English synthetic questions](../../spikes/decision-models/data/questions.json).
There are no real people, records or private data.
Domains are tutor, support, write-confirmation and privacy, 50 questions each.
Types are boolean (72), choice (64) and five-level score (64).
Every label derives from template slots, including confirmation and privacy state facts.

Paired template indices assign half of every domain/type stratum to calibration and half
to held-out evaluation: 100 calibration questions and 100 evaluation questions.
The calibration split fits any future temperature or threshold; this unit fits neither.
The evaluation split stays held out and is reported separately.
Paired, simple templates limit transfer evidence; they are not independent natural host data.

Accuracy includes overall, domain and type counts with Wilson 95% intervals per split.
ECE has 10 equal-width bins over [0,1]; confidence 1 goes in the final bin.
Each confidence-bearing answer contributes to ECE; bins below 10 answers are flagged.
Missing confidence is counted explicitly, including individual missing answers.
No confidence yields `not_applicable_no_confidence`, without a numeric ECE.
Built-in AI provides no confidence and therefore always asks at a confidence gate.

Latency fixtures use deterministic filler states of about 200 and 1,000 tokens.
The mock approximation is ceil(UTF-16 code units / 4), explicitly not a model tokenizer.
The Prompt API's native input counter is used when available; otherwise counts remain null.
Latency questions are the first 10 or 30 descriptors and are never scored.
Thirty questions mean two explicit caller requests, 16 and 14, with repeated state.
Per-request, aggregate and repeated-state cost are reported separately.
Native 30-question experiments remain separately not run.

## Functional observations

- Load, dispose and reload, followed by final disposal.
- Abort a decision, require it to settle, then succeed on a new request.
- Reject more than 16 questions without truncating.
- Reject an over-length row without truncating.
- Return complete boolean, choice and score answers with valid types.
- Exercise mock boundaries at 0, 1, 16 and 17 questions.
- Detect silent truncation and accepting 17 questions as separate injected failures.
- Keep every other functional observation passed for each injection.
- Preserve `not_run` for inference checks that were not executed.

The mock row bound is 4,096 simulated tokens, including question descriptors.
The baseline uses the same harness admission bound plus native quota checks when exposed.
Neither is a claim about a dedicated candidate's actual context window.
Dedicated inference checks remain not run, even when session loading succeeds.

## Proposed recommendation pass bar

**PROPOSED: the maintainer must review and may revise this bar before the device run.**
It informs a model recommendation only and never gates framework parity or releases.

- All applicable functional checks pass, with no truncation or invented inference.
- Held-out boolean and choice accuracy is at least 0.85 for each type.
- Held-out ECE is at most 0.08, with every counted bin holding at least 10 answers.
- Quantized browser answers agree with a pinned reference on at least 0.95 of questions.
- Warm session load is under 10 seconds on the maintainer's recorded device.
- First decision is under 2 seconds for 200 state tokens and 10 questions on that device.
- Structured-output Built-in AI numbers are reported alongside as the zero-download comparison.

A candidate missing the bar is **not recommended on this evidence**.
Missing confidence cannot satisfy an ECE criterion through a fabricated zero.
Missing inference or reference evidence prevents a dedicated recommendation.
Uncertainty, sparse bins and unavailable configurations accompany any interpretation.
The bar is not transferable to another host without that host's own evidence.

## Pinned inventory and licenses

The authoritative [inventory](../../spikes/decision-models/data/inventory.json) lists exact
per-file bytes, digest kind/value, source, role, license facts and missing-value notes.
Facts were supplied by the host's fetch on 2026-11-07, not re-verified by this implementation.

| Candidate | Revision | Weights | Code |
| --- | --- | --- | --- |
| d1-2B ONNX | `2fd61486312020c30a1e3aa5aa677424672b2b37` | `other`, `lfm1.0`, LFM Open License v1.0 | Separate code terms need host review |
| WaterSheep 0.1.0 | `236de6496b530d37e36a8ac63ff8412e92940f6e` | Apache-2.0 | Not stated on the fetched page |
| Laya English q4 | `70aa37224bb0aa778a5375bbc4dade43b0236fd4` | Apache-2.0 per README | Repository Apache-2.0 |
| Built-in AI LanguageModel | null, browser managed | Not established here | Browser-managed terms |

d1 is not Apache-2.0; its LFM Open License v1.0 needs the host review in ADR-0028,
including its commercial revenue threshold wording; this is an inventory, not legal advice.
Every host remains responsible for model rights, including runtime downloads.
No weights are distributed with the spike.

WaterSheep discrepancy: the ADR candidate table says `watersheep.js` exists, but the
pinned revision's complete file list contains no such file; the inventory preserves that list.
Its browser packing/context contract is therefore unknown and unresolved.
Laya's manifest is `english/manifest.json`, not repository-root `HEAD/manifest.json`.
Its eight parts total 336552622 bytes; whole-file SHA-256 and every part digest are pinned.
Laya tokenizer/config sizes and digests were not fetched and remain null pending device recording.
d1's vision pairing is inventoried and downloaded, but is not run for text-only questions.

## Mechanisms implemented and evidence boundary

The mock worker supplies deterministic wrong/right typed answers and synthetic confidence.
Its no-confidence variant exercises the not-applicable calibration path.
Headless smoke is designed to verify the matrix, batching, summary statistics and reports.
It blocks/counts non-local requests and prohibits real session creation/downloads.
It checks inventory representation, byte-identical question regeneration and content-free exports.
It exercises reference import, optional manual memory inputs and validated downloads.
These are harness observations only when the checks actually run.

Real-arm mechanisms are implemented for host build checks: availability, progress,
verified revision-named caches, separate transfer/session timings and ORT metadata capture.
Cached bytes are rehashed, and size/digest mismatches stop loading and evict the file.
Missing digests are never called verified; actual SHA-256 and byte counts are recorded.
ORT factories/WASM are locally bundled; only the pinned download origins/CDN are permitted.
Probes never create sessions, and real loads follow an explicit Run click.

The implementation sandbox cannot install spike dependencies or run Chromium.
The host performs install, typecheck, build and mock smoke before accepting those mechanisms.
Nothing in this implementation task runs a real model or establishes a real-device metric.

Dedicated inference is deliberately absent, pending separate work:

- WaterSheep: locate/publish browser packing and explicit non-truncating context handling.
- Laya: document `marker_pos`, `marker_mask`, `qtype` and answer decoding.
- d1: port documented Python row packing and answer-slot decoding to JavaScript.

No guessed markers, question-type codes, packing, tensors or answers are introduced.
No raw zero-filled forward-pass probe is added.

## Maintainer run procedure

1. Review this plan, proposed bar, licenses and inventory gaps before downloading anything.
2. Install the isolated workspace, generate/check questions, typecheck, build and run mock smoke.
3. Record the device/browser profile above and save the generated smoke evidence.
4. Use normal foreground Chrome and one selected real arm per page load with `runs=20`.
5. Start with `probe=real`; save unavailable observations without treating them as failures.
6. Remove probe mode and click Run only after reviewing download sizes and host rights.
7. Record uncached transfer separately from the second session's warm creation time.
8. At the loaded dedicated-session pause, use OS or Chrome Task Manager readings.
9. Record the decision model alone, then with a pinned chat model resident on the same GPU.
10. Follow the README's exact manual procedure and scope/attribution notes; never estimate.
11. Enter optional MiB readings, or mark coexistence unsupported, then release the model.
12. Import a separately executed pinned reference's complete id/value JSON when available.
13. Download validated JSON and Markdown, retaining every UNMEASURED reason.
14. A later inference implementation is required before accuracy/calibration/latency comparison.
15. Publish any later model recommendation separately, after the maintainer reviews the evidence.

## Open items and stop condition

- Host install/typecheck/build/Chromium smoke remain separate from the sandbox's Node checks.
- Device/browser evidence, real Built-in AI baseline behavior and token exposure remain unmeasured.
- All dedicated inference, accuracy, ECE, agreement and decision latency remain unmeasured.
- GPU memory and coexistence remain manual, optional and unattributed until recorded.
- Pinned reference execution is external to the browser and has not run here.
- WaterSheep browser-code discrepancy and code-license statement remain unresolved.
- Laya metadata pins and all three inference contracts need later bounded implementation work.
- Host license review remains a maintainer responsibility before any model download.

Stop this implementation at the isolated harness, deterministic data and written plan.
Do not change packages, ADRs, project status, existing spikes or the size budget.
Do not perform the maintainer device run or recommend a dedicated model from mock output.
