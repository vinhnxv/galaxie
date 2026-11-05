// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  parseModelRecord,
  transformersDtypes,
} from '../../packages/models/src/transformers/model-record.js';
import { xmlTemplate } from '../../packages/models/test/support/xml-template.js';
import {
  PinError,
  type PinRequest,
  parseArguments,
  pinDtypes,
  pinModel,
} from '../../scripts/pin-onnx-model.js';

const script = fileURLToPath(new URL('../../scripts/pin-onnx-model.ts', import.meta.url));
const revision = '0123456789abcdef0123456789abcdef01234567';
const modelId = 'example-org/tiny-chat';
const request: PinRequest = { modelId, revision, dtype: 'q4', device: 'webgpu' };

const hermesTemplate = `{%- if tools %}<|im_start|>system
You may call functions.
<tools>
{%- for tool in tools %}
{{ tool | tojson }}
{%- endfor %}
</tools>
Reply with <tool_call>{"name": "...", "arguments": {...}}</tool_call> to call one.<|im_end|>
{% endif -%}
{%- for message in messages %}
{%- if message.role == 'assistant' and message.tool_calls %}<|im_start|>assistant
{%- for call in message.tool_calls %}
<tool_call>
{"name": "{{ call.function.name }}", "arguments": {{ call.function.arguments | tojson }}}
</tool_call>
{%- endfor %}<|im_end|>
{% elif message.role == 'tool' %}<|im_start|>user
<tool_response>
{{ message.content }}
</tool_response><|im_end|>
{% else %}<|im_start|>{{ message.role }}
{{ message.content }}<|im_end|>
{% endif -%}
{%- endfor %}
{%- if add_generation_prompt %}<|im_start|>assistant
{% endif %}`;

const plainTemplate =
  '{% for message in messages %}{{ bos_token }}{{ message.role }}: {{ message.content }}{{ eos_token }}\n{% endfor %}{% if add_generation_prompt %}assistant: {% endif %}';

const encoder = new TextEncoder();
const text = (value: string | object): Uint8Array =>
  encoder.encode(typeof value === 'string' ? value : JSON.stringify(value));

interface FakeRepository {
  readonly files: Map<string, Uint8Array>;
  readonly card: unknown;
  readonly sizes?: Map<string, number>;
  readonly missing?: Set<string>;
}

function repository(template: string | null = hermesTemplate): FakeRepository {
  const files = new Map<string, Uint8Array>([
    ['config.json', text({ model_type: 'tiny', max_position_embeddings: 32768 })],
    ['generation_config.json', text({ do_sample: true })],
    ['tokenizer.json', text({ model: { type: 'BPE' } })],
    [
      'tokenizer_config.json',
      text({
        bos_token: null,
        eos_token: '<|im_end|>',
        ...(template === null ? {} : { chat_template: template }),
      }),
    ],
    ['README.md', text('# card')],
    ['onnx/model.onnx', new Uint8Array([1, 2, 3, 4])],
    ['onnx/model_fp16.onnx', new Uint8Array([5, 6, 7])],
    ['onnx/model_q4.onnx', new Uint8Array([8, 9, 10, 11, 12])],
    ['onnx/model_q4.onnx_data', new Uint8Array(70).fill(13)],
    ['onnx/model_q4.onnx_data_1', new Uint8Array(30).fill(14)],
    ['onnx/model_q4f16.onnx', new Uint8Array([15, 16])],
    ['onnx/model_q4f16.onnx_data', new Uint8Array(20).fill(17)],
  ]);
  return { files, card: { cardData: { license: 'apache-2.0' } } };
}

function serve(repo: FakeRepository): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const base = 'https://huggingface.co';
  const fake = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url === `${base}/api/models/${modelId}/tree/${revision}?recursive=true`) {
      const entries = [
        { type: 'directory', path: 'onnx' },
        ...[...repo.files].map(([path, bytes]) => ({
          type: 'file',
          path,
          size: repo.sizes?.get(path) ?? bytes.length,
        })),
      ].filter((entry) => !repo.missing?.has(entry.path));
      return Response.json(entries);
    }
    if (url === `${base}/api/models/${modelId}/revision/${revision}`)
      return Response.json(repo.card);
    const prefix = `${base}/${modelId}/resolve/${revision}/`;
    if (url.startsWith(prefix)) {
      const bytes = repo.files.get(url.slice(prefix.length));
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes as Uint8Array<ArrayBuffer>);
    }
    return new Response(null, { status: 404 });
  };
  return { fetch: fake as typeof fetch, urls };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('pins the files the dtype needs into a record that passes validation', async () => {
  const repo = repository();
  const network = serve(repo);
  const result = await pinModel(request, { fetch: network.fetch });
  const expectedPaths = [
    'config.json',
    'generation_config.json',
    'onnx/model_q4.onnx',
    'onnx/model_q4.onnx_data',
    'onnx/model_q4.onnx_data_1',
    'tokenizer.json',
    'tokenizer_config.json',
  ];
  expect(result.record.files.map((file) => file.path)).toEqual(expectedPaths);
  for (const file of result.record.files) {
    const bytes = repo.files.get(file.path) as Uint8Array;
    expect(file).toEqual({ path: file.path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  expect(result.record).toMatchObject({
    modelId,
    baseUrl: `https://huggingface.co/${modelId}/resolve/${revision}/`,
    revision,
    device: 'webgpu',
    dtype: 'q4',
    contextWindow: 4096,
    toolFormat: 'hermes',
  });
  expect(result.license).toBe('apache-2.0');
  expect(result.template).toEqual({
    rendered: true,
    declarations: true,
    calls: true,
    results: true,
    hermes: true,
    mentionsEnableThinking: false,
  });
  expect(() => parseModelRecord(JSON.parse(JSON.stringify(result.record)))).not.toThrow();
  expect(network.urls.some((url) => url.endsWith('/onnx/model_fp16.onnx'))).toBe(false);
  expect(network.urls.some((url) => url.endsWith('/README.md'))).toBe(false);
});

test('selects the plain model file for fp32 and honors the device and context window options', async () => {
  const result = await pinModel(
    { ...request, dtype: 'fp32', device: 'wasm', contextWindow: 2048 },
    { fetch: serve(repository()).fetch },
  );
  expect(result.record.files.map((file) => file.path)).toEqual([
    'config.json',
    'generation_config.json',
    'onnx/model.onnx',
    'tokenizer.json',
    'tokenizer_config.json',
  ]);
  expect(result.record).toMatchObject({ device: 'wasm', dtype: 'fp32', contextWindow: 2048 });
});

function splitRepository(): FakeRepository {
  const repo = repository(xmlTemplate);
  for (const path of repo.files.keys()) if (path.startsWith('onnx/')) repo.files.delete(path);
  for (const name of ['embed_tokens', 'decoder_model_merged', 'vision_encoder', 'audio_encoder']) {
    repo.files.set(`onnx/${name}_q4.onnx`, new Uint8Array([1, 2, 3]));
    repo.files.set(`onnx/${name}_q4.onnx_data`, new Uint8Array([4, 5]));
    repo.files.set(`onnx/${name}_q4.onnx_data_1`, new Uint8Array([6]));
    repo.files.set(`onnx/${name}_fp16.onnx`, new Uint8Array([7]));
  }
  return repo;
}

test('selects split decoder and embed shards, omits encoders and prints the text-only size', async () => {
  const repo = splitRepository();
  const network = serve(repo);
  const result = await pinModel(request, { fetch: network.fetch });
  expect(result.record.files.map((file) => file.path)).toEqual([
    'config.json',
    'generation_config.json',
    'onnx/decoder_model_merged_q4.onnx',
    'onnx/decoder_model_merged_q4.onnx_data',
    'onnx/decoder_model_merged_q4.onnx_data_1',
    'onnx/embed_tokens_q4.onnx',
    'onnx/embed_tokens_q4.onnx_data',
    'onnx/embed_tokens_q4.onnx_data_1',
    'tokenizer.json',
    'tokenizer_config.json',
  ]);
  expect(network.urls.some((url) => /vision_encoder|audio_encoder|fp16/.test(url))).toBe(false);
  expect(result.record.toolFormat).toBe('xml');
  expect(result.textOnlyBytes).toBe(result.record.files.reduce((sum, file) => sum + file.bytes, 0));
  expect(result.license).toBe('apache-2.0');
  expect(parseModelRecord(JSON.parse(JSON.stringify(result.record)))).toEqual(result.record);
});

test.each(['embed_tokens', 'decoder_model_merged'])(
  'a split export missing %s fails with the fixed missing-file message before fetching files',
  async (name) => {
    const repo = splitRepository();
    repo.files.delete(`onnx/${name}_q4.onnx`);
    const network = serve(repo);
    await expect(pinModel(request, { fetch: network.fetch })).rejects.toThrow(
      'The model repository lacks a file the provider needs.',
    );
    expect(network.urls).toHaveLength(1);
  },
);

test('prefers the single model when both single and split files are listed', async () => {
  const repo = splitRepository();
  repo.files.set('onnx/model_q4.onnx', new Uint8Array([1]));
  const result = await pinModel(request, { fetch: serve(repo).fetch });
  expect(
    result.record.files.filter((file) => file.path.startsWith('onnx/')).map((file) => file.path),
  ).toEqual(['onnx/model_q4.onnx']);
  expect(() => parseModelRecord(result.record)).not.toThrow();
});

test('detects XML in a single-file export and validates the printed record', async () => {
  const result = await pinModel(request, { fetch: serve(repository(xmlTemplate)).fetch });
  expect(result.record.toolFormat).toBe('xml');
  expect(result.template.hermes).toBe(false);
  expect(() => parseModelRecord(result.record)).not.toThrow();
});

test('a declaration with tool_call instructions and another call syntax gets no tool format', async () => {
  const other = `{% if tools %}{{ tools | tojson }} <tool_call>instructions</tool_call>{% endif %}{% for message in messages %}{{ message.content }}{% for call in message.tool_calls or [] %}call:{{ call.function | tojson }}{% endfor %}{% endfor %}`;
  const result = await pinModel(request, { fetch: serve(repository(other)).fetch });
  expect(result.template).toMatchObject({
    declarations: true,
    calls: true,
    results: true,
    hermes: false,
  });
  expect(result.record).not.toHaveProperty('toolFormat');
  expect(() => parseModelRecord(result.record)).not.toThrow();
});

test('a template that declares tools but never renders the call or its result gets no tool format', async () => {
  const declaresOnly = `{% if tools %}Tools: {{ tools | tojson }} use <tool_call>...</tool_call>{% endif %}{% for message in messages %}{% if message.role == 'user' or message.role == 'system' %}{{ message.content }}{% endif %}{% endfor %}`;
  const result = await pinModel(request, { fetch: serve(repository(declaresOnly)).fetch });
  expect(result.template).toMatchObject({ declarations: true, calls: false, hermes: false });
  expect(result.record).not.toHaveProperty('toolFormat');
});

test('rejects a template problem before any weight file is downloaded', async () => {
  const network = serve(repository('{% if %}'));
  await expect(pinModel(request, { fetch: network.fetch })).rejects.toThrow(
    'The chat template could not be rendered.',
  );
  expect(network.urls.some((url) => url.includes('/onnx/'))).toBe(false);
});

test('refuses a paginated file listing instead of pinning a partial one', async () => {
  const network = serve(repository());
  const paginated: typeof fetch = async (input, init) => {
    const response = await network.fetch(input, init);
    return String(input).includes('/tree/')
      ? new Response(response.body, {
          headers: { link: '<https://huggingface.co/next>; rel="next"' },
        })
      : response;
  };
  await expect(pinModel(request, { fetch: paginated })).rejects.toThrow(
    'The model file list could not be read.',
  );
});

test('a template without tool support leaves the tool format out of the record', async () => {
  const result = await pinModel(request, { fetch: serve(repository(plainTemplate)).fetch });
  expect(result.template).toMatchObject({ rendered: true, declarations: false, hermes: false });
  expect(result.record).not.toHaveProperty('toolFormat');
});

test('reports a template that reads enable_thinking', async () => {
  const thinking = `{% if enable_thinking is defined and not enable_thinking %}no-think{% endif %}${hermesTemplate}`;
  const result = await pinModel(request, { fetch: serve(repository(thinking)).fetch });
  expect(result.template.mentionsEnableThinking).toBe(true);
});

test('prefers a separate chat_template.jinja file over the tokenizer config', async () => {
  const repo = repository(plainTemplate);
  repo.files.set('chat_template.jinja', text(hermesTemplate));
  const result = await pinModel(request, { fetch: serve(repo).fetch });
  expect(result.template.hermes).toBe(true);
  expect(result.record.files.map((file) => file.path)).toContain('chat_template.jinja');
});

test.each([
  ['a template that does not render', '{% if %}', 'The chat template could not be rendered.'],
  [
    'a template that raises',
    "{{ raise_exception('this model rejects tools') }}",
    'The chat template could not be rendered.',
  ],
  ['no chat template', null, 'The model has no chat template.'],
])('fails with a fixed message for %s', async (_name, template, message) => {
  const error: unknown = await pinModel(request, {
    fetch: serve(repository(template)).fetch,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PinError);
  expect((error as Error).message).toBe(message);
});

test.each([['tokenizer.json'], ['config.json'], ['onnx/model_q4.onnx']])(
  'fails when the repository lacks %s',
  async (path) => {
    const repo = { ...repository(), missing: new Set([path]) };
    await expect(pinModel(request, { fetch: serve(repo).fetch })).rejects.toThrow(
      'The model repository lacks a file the provider needs.',
    );
  },
);

test('fails with fixed messages when a file is missing, mis-sized or the metadata is unreadable', async () => {
  const sized = { ...repository(), sizes: new Map([['tokenizer.json', 999]]) };
  await expect(pinModel(request, { fetch: serve(sized).fetch })).rejects.toThrow(
    'A model file could not be downloaded and hashed.',
  );
  // The listing was taken before the file vanished from the resolve endpoint.
  const listing = serve(repository());
  const dropped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.endsWith('/onnx/model_q4.onnx_data')
      ? new Response(null, { status: 404 })
      : listing.fetch(input, init);
  };
  await expect(pinModel(request, { fetch: dropped })).rejects.toThrow(
    'A model file could not be downloaded and hashed.',
  );
  await expect(
    pinModel(request, { fetch: async () => new Response(null, { status: 500 }) }),
  ).rejects.toThrow('The model file list could not be read.');
});

test('reads the license from a tag and reports none when the card names none', async () => {
  const tagged = { ...repository(), card: { tags: ['transformers', 'license:gemma'] } };
  expect((await pinModel(request, { fetch: serve(tagged).fetch })).license).toBe('gemma');
  const bare = { ...repository(), card: { cardData: {} } };
  expect((await pinModel(request, { fetch: serve(bare).fetch })).license).toBeNull();
});

test('asks for a context window when the model config names none', async () => {
  const repo = repository();
  repo.files.set('config.json', text({ model_type: 'tiny' }));
  await expect(pinModel(request, { fetch: serve(repo).fetch })).rejects.toThrow(
    'Pass --context-window for this model.',
  );
});

test('parses arguments and rejects mutable revisions, unknown dtypes and bad options', () => {
  expect(parseArguments([modelId, revision, 'q4'])).toEqual({
    modelId,
    revision,
    dtype: 'q4',
    device: 'webgpu',
  });
  expect(
    parseArguments([modelId, revision, 'q4f16', '--device', 'wasm', '--context-window', '2048']),
  ).toEqual({ modelId, revision, dtype: 'q4f16', device: 'wasm', contextWindow: 2048 });
  for (const argv of [
    [],
    [modelId, revision],
    [modelId, 'main', 'q4'],
    [modelId, revision.toUpperCase(), 'q4'],
    [modelId, revision, 'q5'],
    ['../escape', revision, 'q4'],
    [modelId, revision, 'q4', '--device', 'cpu'],
    [modelId, revision, 'q4', '--context-window', '0'],
    [modelId, revision, 'q4', '--context-window', 'many'],
    [modelId, revision, 'q4', '--unknown'],
    [modelId, revision, 'q4', 'extra'],
  ])
    expect(parseArguments(argv)).toBeUndefined();
});

test('accepts exactly the dtypes the record accepts', () => {
  expect([...pinDtypes].sort()).toEqual([...transformersDtypes].sort());
});

test.each([[[]], [['example-org/tiny-chat', 'main', 'q4']]])(
  'the command prints usage and exits non-zero for arguments %j',
  (argv) => {
    const run = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Usage: node scripts/pin-onnx-model.ts');
  },
);
