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
- The WASM backend and any other browser, GPU or operating system.
- `LiquidAI/LFM3-1.7B-ONNX`: deferred. Its q4 data file is about 1.63 GB, above the record's 1 GiB per-file limit, and no record is pinned.
- Answer quality, tool-call reliability and financial or lending quality: no claim is made.

## Mocked or blocked

Every automated test of these recipes uses scripted or fake models. The Pyodide and Go lanes run with verified wheels and the reference wasm.
