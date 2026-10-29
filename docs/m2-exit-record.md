# M2 exit record

Date: 2026-10-29. Device: Apple M5 Pro, macOS, Chrome 155, WebGPU adapter `apple metal-3`. Raw figures are in [`examples/host-local/results/2026-10-29-apple-m5-pro-chrome-155.json`](../examples/host-local/results/2026-10-29-apple-m5-pro-chrome-155.json). Everything below is a demonstration on one device (brief §18), not a pass/fail gate.

## What ran

The default-mode build of `examples/host-local` was served with `vite preview` on `http://127.0.0.1:4173`, with its CSP header. The maintainer's Chrome was driven through browser automation. Two full lessons ran on real models, through every step of brief §4.2 from 1 to 10: lesson, generated quiz, deterministic grading, private sentence review, Feedback, saved progress and Progress.

| Run | Route | Result |
| --- | --- | --- |
| Built-in AI | `LanguageModel` available for English; Built-in AI is first in the route order | Succeeded, 3/4 |
| WebLLM | `LanguageModel` removed from the page before **Prepare models**, so only WebLLM on WebGPU remained | Succeeded, 1/3 |

On the WebLLM run, Prepare took 1.3 s with cached weights. The quiz appeared 13.0 s after Start, and Feedback 4.6 s after the sentence was submitted. Both structured calls on both runs produced schema-valid output with no repair.

## Acceptance tests

- **AT-03, real local inference: verified on this device** for Built-in AI and for WebLLM on WebGPU. CI does not run real models and does not count toward AT-03 (brief §17).
- **AT-04, local-only policy: verified for page requests on this device, and in CI with the mock provider.**
  - On both real runs, the page made 9 resource requests, all same-origin, and none contained the sentinel sentence. Model weights were already cached at this origin, so the capture covers the run after caching, as AT-04 states.
  - The capture used the page's Resource Timing entries and the browser extension's network log. Neither includes requests made by the WebLLM dedicated worker. The CI loop test in `examples/host-local/test/loop.node.test.ts` does route worker traffic, but with the mock provider and an inert worker.
  - The browser's own Built-in AI traffic is outside the page and outside this capture.

## Not measured

- First download size and time: the WebLLM weights were cached by an earlier Spike B session at the same origin and model commit, and the browser manages the Built-in AI download.
- Time to first token, and p50/p95: one run per path.
- Main-thread long tasks during inference (the ADR-0003 watch item) and memory use.
- Which provider served the first run: inferred from the route order, not observed, because the host does not display `snapshot.routes`.

## Observations

These are model-quality notes, not galaxie defects:

- On the WebLLM run, the review called `my brother drink tea every evening` correct, missing the subject-verb error.
- Both runs' quizzes contained questions where more than one option could be read as acceptable.

Scoring answer quality is the agent author's work (brief §18).

## Mocked or blocked

- **Mocked:** every CI test of the tutor and the host uses the mock provider or a fake `LanguageModel`.
- **Not yet built:** reload restore and draft persistence (M3), remote providers, user endpoints and MCP.
