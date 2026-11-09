# ADK recipes real-model record

Date: 2026-11-05 and 2026-11-06. Device: Apple M5 Pro, macOS, Chrome 155, WebGPU adapter `apple metal-3`. Everything below is a demonstration on one device, not a pass/fail gate and not a measurement of answer quality. CI never runs a real model.

## What ran

The default-mode build of [`examples/adk-recipes`](../examples/adk-recipes/README.md) was served with `vite preview` under its unchanged CSP (`connect-src 'self' https://huggingface.co https://us.aws.cdn.hf.co`). The model was `onnx-community/Qwen3.5-0.8B-ONNX-OPT`, q4, WebGPU, 4096-token context, XML tool format, at the revision in the pinned record (`9a4c21d8f724176b0a7edaaed36303044451886e`). The download is 666 MB across nine files, each checked against its SHA-256 in the record.

| Run | Result |
| --- | --- |
| Financial advisor, ADK JavaScript | Succeeded, about 40 s with cached weights |
| Financial advisor, ADK Go | Succeeded, about 40 s with cached weights |
| LLM auditor, ADK Python | Succeeded, about 50 s with cached weights |
| Small-business loan, ADK Python | Reached the approval pause. The 0.8B model supplied an applicationId that does not exist, and the host's strict validation rejected it with its fixed alert. Validation worked; reliable completion would need prompt work. |

One run per recipe. Two defects found by these runs were fixed before the table above: the prompt plus a 1024-token reply overflowed the 4096-token context on the third financial agent (reply cap now 384 tokens), and the history mapper rejected the OpenAI-format mirror of assistant tool calls on the auditor's second model call.

## Clean profile and first download

A fresh Chrome profile with an empty cache ran the financial JavaScript recipe through a scripted browser. The consent dialog named 666 MB. From clicking Run to `succeeded` took 48 s, with the downloads complete at about 26 s. No CSP violation or alert appeared. The request log, which includes worker requests, shows the model files requested from `huggingface.co` and redirected to `us.aws.cdn.hf.co`, so the redirect host is `us.aws.cdn.hf.co`. The maintainer then repeated the first download on a second fresh profile by hand: clicking OK on the browser's own confirmation dialog started the download and the run succeeded.

## Not measured

- p50/p95, time to first token, memory and main-thread long tasks: one run per recipe.
- The Cancel path of the native dialog by a human.
- The WASM backend and any other GPU or operating system. Browsers other than Chrome 155 have only the short probe below.
- `LiquidAI/LFM3-1.7B-ONNX`: deferred. Its q4 data file is about 1.63 GB, above the record's 1 GiB per-file limit, and no record is pinned.
- Answer quality, tool-call reliability and financial or lending quality: no claim is made.

## Mocked or blocked

Every automated test of these recipes uses scripted or fake models. The Pyodide and Go lanes run with verified wheels and the reference wasm.

## Safari and Firefox probe

Date: 2026-11-09. Device: Apple M5 Pro, macOS 27.2. Browsers: Safari 27.2 and Firefox 159.0.1, the release builds installed on the machine. One run each, a manual demonstration and not a pass/fail gate.

A throwaway page, not committed, ran the same reviewed record as above (`onnx-community/Qwen3.5-0.8B-ONNX-OPT`, q4, WebGPU, revision `9a4c21d8…`, 666 MB) through `loadTransformersEngine` and `TransformersEngineHandle.stream`. It was built and served with the adk-recipes default-mode CSP and Trusted Types policy unchanged. The page bypassed the app's consent dialog by passing `allowDownload: true`, because the browsers could not be clicked in this session. It then sent two single-turn prompts at temperature 0 and a 48-token limit.

| | Safari 27.2 | Firefox 159.0.1 |
| --- | --- | --- |
| WebGPU adapter | present, vendor `apple` | present, empty vendor and architecture labels |
| `shader-f16` | present | present |
| Worker backend | `webgpu` | `webgpu` |
| Download, verify and load | 666 MB checked against the record; ready after 34 s | same; ready after 24 s |
| "Reply with exactly three words describing the sea." | `Blue`, first chunk 1.27 s | `Blue`, first chunk 1.85 s |
| "What is 12 plus 30? Answer with the number only." | `42`, 0.16 s | `42`, 0.70 s |

The timings include one network download each and are not latency distributions. The first reply is one word where the prompt asked for three; this says something about a 0.8B model, not about the framework, and no answer-quality claim is made.

Not covered by this first probe: the app UI and its consent dialog, tool calls, the WASM backend, repeated runs, memory, main-thread long tasks, abort, and reload or recovery with a real model. The recipe attempt below covers a full ADK recipe.

### Financial advisor (ADK JavaScript) on Safari and Firefox

Same day, device and record. This time the real default-mode app ran the "Financial advisor (JavaScript)" recipe with its sample question: `App`, `createRecipeHost`, the ONNX record and the ADK JavaScript executor, under the unchanged CSP. A throwaway page replaced `confirm()` with a function that returns `true` and pressed the app's Run button from script, because the browsers could not be clicked in this session. Weights were already cached. The recipe makes five model calls (the data agent calls twice around its search tool, then the trading, execution and risk agents), each limited to 384 tokens. Two runs per browser gave the same outcome. On Chrome 155 the same recipe succeeded in about 40 s (first table above). **Neither browser completed it.**

| | Safari 27.2 | Firefox 159.0.1 |
| --- | --- | --- |
| Calls 1 to 3 | finished in 1.5 s, 9.2 s and 10.2 s | finished in 7 s, 78 s and 79 s |
| Call 4 (2211 prompt tokens) | failed after about 3 s: the Worker reported `provider` | finished in 81 s |
| Call 5 (2994 prompt tokens) | not reached | aborted at 300.7 s |
| Run result in the app | `failed`, "The requested service is unavailable." | `failed`, "The budget limit was reached." |
| Output shown | three agents' text | four agents' text |

**Safari.** The failure depends on how long one prefill runs, not on the recipe. A separate prompt-length probe, with the same record and no tools, completed prompts of up to 2097 tokens and failed at one of about 2180 tokens (estimated from the same filler's earlier counts, because the failed call reports none). Further runs on the same machine used throwaway pages that were not committed:

- A 2036-token prompt followed by 700 generated tokens (2736 in total) completed, so the limit is the size of one prefill, not the sequence length.
- GPU memory in use (`ioreg`, `AGXAccelerator`, "In use system memory") was about 1.0 GB idle, about 2.5 GB with the model loaded and about 3.0 GB at the start of the failing call, and fell back to about 1.0 GB when the device was destroyed. The GPU `recoveryCount` stayed 0. The page's WebContent process reached 2.5 to 3.4 GB resident and stayed near 2.4 GB after the engine was disposed while the tab stayed open. The machine has 24 GB.
- With another tab running a continuous 2048 x 2048 f32 matrix-multiply loop on WebGPU, an 817-token prompt (about 1 s alone) failed after 3.2 s. Once that tab was gone, the same prompts passed.
- Running the decoder graph directly with ONNX Runtime and placeholder embeddings, a single 1800-token run took 2.5 s and passed, and a single 2200-token run failed after 3.2 s with the same error. The same 2200, 3200 and 4000 tokens split into chunks of 256, 512 or 1024 tokens all passed, with the slowest single run between 0.4 s and 2.0 s and about the same total time. With the matrix-multiply tab running, 2200 tokens in chunks of 256 passed (slowest run 1.9 s) while a single 900-token run failed.

So a single model run that lasts about 3 s or more fails, and the prompt length at which that happens falls as the GPU gets busier. With a temporary diagnostic in a local copy of the Worker (not committed), the first failure was a `GPUDevice.lost` event with reason `destroyed`, followed by ONNX Runtime's `OrtRun()` error `BufferManager::Download ... map async was not successful`. macOS wrote a `com.apple.WebKit.GPU` crash report for the same moments. Its crashed thread ran from `WebGPU::Queue::commitMTLCommandBuffer` into `WebGPU::crashGPUProcess` and `Device::loseTheDevice`; one report ended in a null-pointer SIGSEGV inside the device-lost callback. The whole WebKit GPU process went down: the device of the other tab was lost too. The Metal error code is not in the report, and the system log redacts it, so this record does not claim that Metal's command-buffer time limit is the cause, only that the evidence points at a time limit and not at memory or sequence length. The framework sees only a fixed `provider` failure by design. The ONNX provider runs the whole prompt in one pass through Transformers.js and does not split the prefill, so a long prompt can fail on Safari.

**Firefox.** Every call completes, including the 2211-token prompt. Generation is slow: about 78 s for 384 tokens, roughly 5 tokens per second, against about 9 s on Safari. The run's default wall-clock budget (`wallClockMs`, 300000) expires during call 5, so the run fails with the budget error rather than a model error. The slowness is not explained. In both runs a stale tab of the earlier probe reloaded and started a second page load; the two runs' timings agree to within 0.1 s although the second page appeared at different moments, so this record does not attribute the slowness to it, but it did not rule it out either.

This is a demonstration on one machine, two runs per browser, not a measurement and not an answer-quality claim. The Python and Go recipes were not tried.
