// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// A synthetic tokenizer and a Hermes-style chat template. Nothing here is a real model's file.

export const MODEL_ID = 'probe/synthetic';

const WORDS = ['<unk>', 'hello', 'world', 'what', 'is', 'the', 'weather', 'in', 'paris'];

export const TOKENIZER_JSON: string = JSON.stringify({
  version: '1.0',
  truncation: null,
  padding: null,
  added_tokens: [
    {
      id: 0,
      content: '<unk>',
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    },
  ],
  normalizer: null,
  pre_tokenizer: { type: 'Whitespace' },
  post_processor: null,
  decoder: null,
  model: {
    type: 'WordLevel',
    vocab: Object.fromEntries(WORDS.map((word, id) => [word, id])),
    unk_token: '<unk>',
  },
});

export const CHAT_TEMPLATE: string = [
  '{%- if tools %}',
  '{{- "<|im_start|>system\\n" }}',
  '{{- "# Tools\\n" }}',
  '{%- for tool in tools %}',
  '{{- tool | tojson }}',
  '{{- "\\n" }}',
  '{%- endfor %}',
  '{{- "<|im_end|>\\n" }}',
  '{%- endif %}',
  '{%- for message in messages %}',
  '{{- "<|im_start|>" + message.role + "\\n" + message.content + "<|im_end|>\\n" }}',
  '{%- endfor %}',
  '{%- if add_generation_prompt %}',
  '{{- "<|im_start|>assistant\\n" }}',
  '{%- endif %}',
].join('');

export const TOKENIZER_CONFIG_JSON: string = JSON.stringify({
  tokenizer_class: 'PreTrainedTokenizer',
  unk_token: '<unk>',
  model_max_length: 128,
  chat_template: CHAT_TEMPLATE,
});

export const FILES: Readonly<Record<string, string>> = {
  'tokenizer.json': TOKENIZER_JSON,
  'tokenizer_config.json': TOKENIZER_CONFIG_JSON,
};

export const TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
} as const;
