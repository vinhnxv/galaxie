# Spike B0: load LFM3-1.7B-ONNX on WebGPU

Throwaway M0 code (brief §16.2). Before Spike B, it checks one thing: whether Chrome can load [LiquidAI/LFM3-1.7B-ONNX](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX) with onnxruntime-web on WebGPU and generate text. Nothing here becomes package code.

## Run it

Node.js 24 and pnpm 11. This folder is its own pnpm workspace, so the root install and CI do not install its dependencies.

```sh
pnpm install
pnpm start
```

Open http://127.0.0.1:4173/ in Chrome and press **Run smoke test**, or open http://127.0.0.1:4173/?autorun to start on load. The page shows a log and a JSON result. The same object is `window.__b0`.

The first run downloads about 1.40 GB from huggingface.co: the q4f16 graph and its weights, the tokenizer, and three small config files, all at revision `189271ef61b9e7fdd4a8b5b0891bcacad37700f8`. The page keeps them in its origin's Cache Storage, and later runs read them from there. Every file is checked against the size and hash that the Hub lists for that revision, and a file that fails the check is removed from the cache. To free the space, clear the site data for `127.0.0.1:4173` in Chrome.

## What the page does

- It calls onnxruntime-web directly (`onnxruntime-web/webgpu`, the WebGPU execution provider) and runs its own generation loop. Transformers.js supports LFM3 from 4.3.2, which was published on 2026-10-27 and is still inside the 7-day release-age gate (`minimumReleaseAge`).
- It keeps the attention and convolution caches on the GPU between steps (`preferredOutputLocation: 'gpu-buffer'`), and builds the empty caches for the first step from the graph's input metadata.
- It renders the model's chat template with `enable_thinking: false`, prefills in chunks of at most 256 tokens, and decodes greedily with a repetition penalty of 1.1 until `<|im_end|>` or 128 new tokens. The model card suggests sampling with temperature 0.1 and top-k 50. Greedy decoding makes runs repeatable.
- It keeps each sequence inside the 256-token sliding window, so the output does not depend on how the graph trims the sliding-window caches.
- It runs two prompts, one in English and one in Vietnamese. The first prompt also pays for shader compilation.
- It uses one WASM thread. The page is not cross-origin isolated, so `SharedArrayBuffer` is not available.

## Model license

The weights are under the LFM Open License v1.0, not AGPL-3.0. The page downloads them at run time, and they are not part of this repository.

## Results

The page loads the model on WebGPU and generates text. Run on 2026-10-28 on an Apple M5 Pro (24 GB) with macOS 26.6.2 and Chrome 155.0.8059.86:

- WebGPU adapter: vendor `apple`, architecture `metal-3`, `shader-f16` available, `maxBufferSize` and `maxStorageBufferBindingSize` 4,294,967,292 bytes.
- onnxruntime-web 1.31.0-dev.20260914-8d85527a0, one WASM thread.

The first run downloaded the weights. The second run, a page reload, read every file from Cache Storage.

| | First run | Second run |
| --- | --- | --- |
| `model_q4f16.onnx_data` (1,382.9 MB) | downloaded in 37.3 s, read back in 1.6 s, hash checked in 2.6 s | read in 1.5 s, hash checked in 1.5 s |
| All files ready | 41.8 s | 3.3 s |
| Session creation | 3.1 s | 2.5 s |
| English prompt: time to first token, decode speed | 377 ms, 73.3 tok/s | 338 ms, 49.8 tok/s |
| Vietnamese prompt: time to first token, decode speed | 109 ms, 67.4 tok/s | 110 ms, 72.1 tok/s |

In the second run, the English answer was complete 7.6 s after the page started.

- The prompts were 26 and 25 tokens long. Both start with token 124894 (`<|startoftext|>`), and each chat-template marker encodes as one special token.
- Both answers stopped at `<|im_end|>`, after 76 and 63 new tokens. Both runs produced the same text, as greedy decoding should.
- onnxruntime-web logged one warning while creating the session: some nodes are not assigned to the WebGPU execution provider. ORT places shape-related ops on the CPU. The warning does not name the nodes.
- No errors.
- After the first run, the origin used 1,401 MB of its 12,139 MB storage quota.
- The five small files were already in the origin's Cache Storage when the first run started, from an earlier page load. The weights were not.

The answers:

> WebGPU is a low-level GPU API that allows web pages to run high-performance graphics and compute operations directly on the browser's GPU hardware, enabling real-time rendering of complex 3D scenes and parallel processing tasks without relying on JavaScript or WebGL. It provides direct access to GPU shaders and memory for efficient handling of large datasets and interactive visualizations in the browser.

> Hà Nội là thủ đô của Việt Nam, với lịch sử hơn 2.000 năm và văn hóa sôi động. Nơi đây nổi tiếng bởi các di tích lịch sử như Đền Văn Thiết Thủ, Chùa Vạn Hương, và hệ thống đường phố đầy màu sắc.

This test does not score quality; Spike B does. For the record, both answers are fluent and both contain factual errors. WebGPU is a JavaScript API. Hanoi's history is usually counted from Thăng Long in 1010, about 1,000 years. "Đền Văn Thiết Thủ" and "Chùa Vạn Hương" are not known Hanoi landmarks.

Limits:

- One machine, one browser, two short prompts, and two runs. The speeds are not benchmarks: the same English prompt decoded at 73.3 tok/s in the first run and 49.8 tok/s in the second.
- Every sequence stayed under 256 tokens, so prefill used one chunk. Longer contexts were not tested.
- Decoding was greedy, not the model card's sampling settings.
- Memory use was not measured.
