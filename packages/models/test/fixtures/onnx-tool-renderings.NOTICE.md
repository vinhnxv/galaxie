# Chat-template rendering notices

These small samples were rendered on 2026-11-05 by `@huggingface/jinja` 0.5.10
from the `chat_template` field of each repository's `tokenizer_config.json`.
The fixture records the source SHA-256, repository, immutable revision and model
card license fields. No template source, tokenizer vocabulary, ONNX file or
weights are included. The samples do not imply endorsement by Qwen, Alibaba,
Hugging Face or Liquid AI.

| Repository | Revision | Model card license notice |
|---|---|---|
| `onnx-community/Qwen3.5-0.8B-ONNX-OPT` | `9a4c21d8f724176b0a7edaaed36303044451886e` | `apache-2.0`, Apache License 2.0; the card links [the Qwen license](https://huggingface.co/Qwen/Qwen3.5-0.8B/blob/main/LICENSE). |
| `LiquidAI/LFM3-1.7B-ONNX` | `e90558fd7388a536a029a4196ddc1c90a234ae9b` | `other`, license name `lfm1.0`, LFM Open License v1.0; the card links [LICENSE at this revision](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX/blob/e90558fd7388a536a029a4196ddc1c90a234ae9b/LICENSE). |

The LFM license is not Apache-2.0. Its commercial revenue restrictions remain
applicable; these fixtures grant no model rights. The maintainer's stated use
is non-commercial experimentation.

Rendering input: system text `You are a helpful assistant.`, user text
`Find a local document.`, an empty assistant message with the function call
`lookup({ q: 'browser notes', limit: 2 })` and ID `call_0`, then the tool result
`Found two notes.` with that ID. The tool description is `Search local documents.`;
its required parameters are `q` (string) and `limit` (integer). Rendering sets
`add_generation_prompt: true` and uses the config's BOS/EOS tokens (null becomes
an empty string). The fixtures contain the whole rendered conversation; parser
tests extract its last assistant tool-call block, excluding instruction examples.
