# Decision model measurement spike

Throwaway instrument for [ADR-0028](../../docs/adr/0028-decision-model-role.md).
The [spike plan](../../docs/plans/2026-11-07-spike-decision-models-plan.md) precedes any
maintainer device run. Implementation stays here; no spike imports another spike or a package.
Copied patterns name their source in header comments.

**Mock numbers are harness evidence only, never a model measurement.** Results are
demonstrations under ADR-0016, not framework quality gates, guarantees or recommendations
for another host's questions. This task runs no models on a real device.

## Run it

Use Node.js 24 and pnpm 11 through Corepack. This is an independent workspace:

```sh
pnpm --dir spikes/decision-models install
pnpm --dir spikes/decision-models build:questions
pnpm --dir spikes/decision-models typecheck
pnpm --dir spikes/decision-models build
pnpm --dir spikes/decision-models start
pnpm --dir spikes/decision-models smoke
```

Open `http://127.0.0.1:4173` in foreground Chrome. The default selects only the mock.
Availability probes never create sessions. **Run** permits selected real-arm downloads;
`probe=real` stops real arms after their probes. Built-in AI may request another **Run**
click if browser activation expired before its download. No provider credentials are used.
The seven-day dependency release-age gate and disabled protobufjs build remain in place.
The host generates the lockfile; this implementation does not supply one.

| Query | Behavior |
| --- | --- |
| `arms=mock` | Default, deterministic worker; no external requests |
| `arms=mock,builtin-ai,watersheep,laya,d1` | Select arms in this order; duplicates removed |
| `probe=real` | Availability only for every real arm, even with a GPU |
| `runs=5` | One discarded warm-up, then five measured trials per latency combination |
| `runs=20` | Nearest-rank p95; fewer than 20 reports null and `fewer_than_20_runs` |
| `mockConfidence=none` | Missing confidence on every mock answer; ECE is not applicable |
| `mockFail=truncate` | Drop the last answer on multi-question requests; answer-type/completeness check fails |
| `mockFail=no-reject-oversize` | Accept 17 questions; oversize rejection check fails |

## What the page checks

Observations are `passed`, `failed` or `not_run`, with fixed reasons. Failures are data,
not page crashes. No failed reply or exception text is exported.

| Functional check | Boundary exercised |
| --- | --- |
| loads | First load, dispose, second load from cache, final disposal |
| cancels | Abort a decision, require settlement, then validate a fresh request |
| rejectsOversize | Reject 17 questions without truncation; also the mock's 17-question boundary |
| rejectsOverlength | Reject an over-length row without truncation |
| answerTypes | Complete boolean, choice and score reply; mock execution observed in a worker |
| packing0 / packing1 / packing16 | Mock-only rejection of empty requests and acceptance of 1 and 16 |

The mock simulates a 4,096-token row bound using `ceil(UTF-16 code units / 4)` on the
serialized state and question descriptors. This is a documented approximation, not any
model's tokenizer. Oversize inputs are rejected, never truncated. Its seeded id/label
function deliberately makes some wrong decisions and supplies imperfect synthetic
confidence. Worker delay is synthetic; observed mock timings include browser scheduling.
The Built-in AI baseline uses the same harness admission bound and additionally checks
its native input quota when exposed. Browser context rejection is never repaired by truncation.

## Arms

The mechanisms are implemented for build checking. A build check alone provides no
device evidence. The implementation sandbox has no installed spike dependencies;
install, typecheck, build and Chromium smoke are host checks. Nothing in this task ran
a real device model. The mock smoke verifies harness mechanisms only.

| Arm | Model and pinned revision | Runtime | Implemented |
| --- | --- | --- | --- |
| mock | deterministic mock, `v1` | Worker | Typed deterministic answers, cancellation, rejection, synthetic confidence |
| builtin-ai | browser-managed LanguageModel, cannot pin | Prompt API on page | Availability, closed enum schema, reply validation, timings, optional native token usage; no confidence |
| watersheep | WaterSheep 0.1.0, `236de6496b530d37e36a8ac63ff8412e92940f6e` | ORT WebGPU worker | Adapter probe, verified download/cache, dispose/reload, session metadata; no inference |
| laya | Laya English q4, `70aa37224bb0aa778a5375bbc4dade43b0236fd4` | ORT WebGPU worker | Same, plus eight-part assembly and total SHA-256; no inference |
| d1 | Liquid d1-2B ONNX, `2fd61486312020c30a1e3aa5aa677424672b2b37` | ORT WebGPU worker | Same, with decoder external data; no inference |

Dedicated arms return `inference_not_implemented`: WaterSheep browser packing is unknown;
Laya's `marker_pos`, `marker_mask` and `qtype` semantics are undocumented; d1's Python
row packing and answer-slot decoding have no JavaScript port. No markers or tensor
semantics are guessed. No zero-filled forward probe is implemented. Dedicated accuracy,
ECE, agreement, decision latency and GPU memory remain **UNMEASURED**.
ORT selects `executionProviders: ['webgpu']`; unsupported operators can still execute on
its WASM provider, as described by the sibling engine spike. Device operator placement is unmeasured.

## Inventory, licenses and network

[data/inventory.json](data/inventory.json) is Zod-validated and contains exact file sizes,
digests, revisions, roles and missing-value notes from the host's source fetch on
2026-11-07. This implementation did **not** re-verify those external facts.
Weight and code licenses are separate: WaterSheep weights are Apache-2.0 and its page
does not state a code license; Laya repository and README-described weights are Apache-2.0;
d1 has tag `other`, name `lfm1.0`, LFM Open License v1.0, not Apache-2.0.
The host must perform the license review described in ADR-0028 before loading weights.
Browser-managed model rights are not established by this inventory.

WaterSheep's pinned repository contains **no `watersheep.js`**, contrary to the ADR's
candidate table. Its complete fetched file list is recorded in the inventory note.
This discrepancy is unresolved. Laya's manifest lives at `english/manifest.json`;
the raw repository-root `HEAD/manifest.json` returns 404 according to the supplied fetch.
The inventory preserves its temperatures and option-group key facts as notes; nothing
fits or applies them in this unit.

Cache names include the full revision. Every cache read recomputes the file digest:
SHA-256, or SHA-1 of UTF-8 `blob <byteLength>\0` followed by the bytes. Sizes are checked
when pinned. Mismatches are recorded, removed from cache and stop loading.
Unpinned Laya metadata files stay `unverified_no_digest`; their actual byte counts and
computed SHA-256 are recorded for the maintainer to review, never labeled verified.
Laya assembly uses the pinned inventory part order and checks 336552622 bytes and the
pinned whole-file digest. The downloaded manifest cannot change the fetch list.
d1 lists and downloads the vision pairing for inventory completeness, but never runs
the vision encoder for text-only questions.

The dev and preview responses apply the sibling's CSP approach, including worker responses.
Static deployment must preserve that response header. Scripts and WASM factories are
local (`script-src 'self' 'wasm-unsafe-eval'`); worker scripts use self/blob only.
Connections allow only self, `https://huggingface.co`, its `https://*.hf.co` large-file
redirects and `https://raw.githubusercontent.com`. These are the pinned file origins
and their download CDN. Fetch uses omitted credentials and no referrer. There is no
telemetry, analytics, remote inference endpoint or CDN WASM fallback.

## Question set and measurement procedure

[scripts/build-questions.ts](scripts/build-questions.ts) deterministically generates
[data/questions.json](data/questions.json) with seed 20261107. The 200 English synthetic
questions contain no real people or data: four domains, 50 each; 72 boolean, 64 choice
and 64 score. Labels derive from the template slots, not model answers.
Paired slot indices assign 50% calibration and 50% held-out evaluation in every
domain/type stratum: 100 questions per split. Paired templates are intentionally simple;
this small synthetic set cannot establish transfer to another host or natural data.

The calibration split fits any later temperature or threshold. This unit fits neither.
The evaluation split remains held out and is reported separately, with Wilson 95%
intervals, counts, and domain/type breakdowns. ECE uses **10 equal-width bins** over
[0,1], with confidence 1 in the final bin. Every confidence-bearing answer contributes;
bins below **10 answers**, including empty bins, are flagged. Missing confidence is
counted per split. With no confidence, `not_applicable_no_confidence` has no numeric ECE.
Built-in AI always returns `confidence: null`: any confidence gate must always ask.

Latency uses separate filler states of exactly 800 and 4000 UTF-16 code units (about
200 and 1,000 mock tokens), and the first 10 or 30 question descriptors. These trials
are **not scored**. Native `measureInputUsage` counts state and full input when the
Prompt API exposes it; unavailable token counts are null, never substituted estimates.
Dedicated tokenizers are not implemented because inference packing is missing.
End-to-end timing includes worker RPC or fresh Prompt API session creation, input
tokenization, inference and validated reply receipt. Tokenization is a separate timing.
Each combination discards one warm-up, then records N trials. Thirty questions are two
explicit caller requests, **16 and 14**, with per-request timings, aggregate timing and
the extra state pass/token cost. Native 30-question experiments stay separately not run.

Download time counts uncached transfer time separately from digest verification and
session creation. Warm load measures the second ORT session creation after disposal and
verified cache reads; it excludes cache-read/hash time. Browser-managed downloads expose
no isolated transfer duration, so their download field says `browser_managed`.
Generated-token cost is a count, not a price: reported only if native output-token usage
is exposed, with missing-usage call counts. No token count is inferred from reply length.

### Manual GPU memory

Browsers expose no GPU allocation measurement API for this purpose. Do not estimate.

1. Use a foreground tab, close unrelated GPU workloads, and record device, OS, browser,
   task-manager tool/version, units, and a baseline idle reading outside the export.
2. Run one dedicated arm. At its loaded-model pause, inspect OS GPU tools or Chrome Task
   Manager's GPU-memory column for the relevant browser/worker process. Record the
   decision-model-alone reading in MiB in the first optional input. These process-level
   readings are not isolated model allocations; retain the baseline and attribution limits.
3. Keep the decision session loaded. Load the chosen chat model in another tab on the
   same GPU, record its model/revision and setup alongside the saved report, and wait
   for both loads to settle. Read the same tool/process scope and enter the combined
   reading in the second input. Do not subtract or estimate an unreported model allocation.
4. Select the correct arm and **Apply manual readings**. If coexistence cannot load or
   the tool cannot attribute it, select **unsupported configuration** and keep the second
   value null. Leave either input empty when no observation is available.
5. Click **Release loaded model** to dispose the session and proceed. Export after the run.

### Pinned reference import

Run the unquantized/pinned reference outside the browser with the same 200 question ids.
The JSON envelope is `{ "candidateId": "laya-english-q4", "revision": "<inventory revision>",
"answers": [{ "id": "<question id>", "value": true }] }`, with exactly 200 unique id/value
records, correctly typed for their questions. No reference prompts, states or prose are
accepted. Choose **Import pinned reference answers**, or use
`window.spikeDecision.importReference(value)`. Matching pinned identity is required;
unrelated arms report `reference_candidate_mismatch`. Answers remain only in memory.
No reference was run by this task: agreement is `reference_not_run` by default.
The smoke's `deterministic-mock` / `v1` reference exercises the import path only.
Dedicated agreement remains unmeasured until a later implementation can run inference.

## Results and smoke

**Download results**, **Download report**, `window.spikeDecision.results()` and
`window.spikeDecision.report()` use the validated versioned contract
`galaxie.spike-decision-models.results/v1`. Exports contain profiles, inventory pins,
computed file digests, counts, numeric measurements and fixed reasons, never question
text, state text or answer values. No prompt/output hashes are collected.
All five arms are represented even when unselected. Each mock arm/trial identifies
`evidence: 'mock-harness'`. The Markdown report opens with the mock banner when mock is
selected and lists every UNMEASURED field with its reason.

The headless Chromium smoke starts Vite on a free local port, blocks and counts every
non-local request, runs normal/no-confidence/failure-injected mocks and real probes only,
checks 5/20-run summaries, boundaries, splits, digest primitives, reference/manual inputs,
validated downloads and absence of text. It asserts zero external requests, page errors
and real session creation. `results/smoke.json` is generated by an actual smoke run,
following the sibling's committed-evidence convention; no fabricated run file is supplied.
The smoke rewrites that file unformatted, so run
`pnpm exec biome check --write spikes/decision-models/results/smoke.json` from the repository
root before committing a new run.
Check committed question bytes without rewriting with:

```sh
node spikes/decision-models/scripts/build-questions.ts --check
```

## Unmeasured

- All dedicated-model inference, accuracy, ECE, reference agreement and decision latency.
- Any real-device latency, transfer duration, warm-load behavior or GPU memory, including coexistence.
- Built-in AI baseline behavior, generated-token exposure, schema failures and always-ask cost on a real device.
- Laya tokenizer/config hashes and sizes, pending device recording and review.
- The WaterSheep `watersheep.js` discrepancy and browser packing/context contract.
- Laya marker/question-type semantics and d1 JavaScript row packing/answer-slot decoding.
- Reference execution and quantization agreement on the held-out questions.
- Host license review, including WaterSheep code rights and the LFM host restrictions.
- Confidence fitting, threshold selection, domain transfer and naturally occurring host data.

The data JSON files are Apache-2.0 like this repository. Inventory license labels describe
external models, not a relicensing of their weights or code.
