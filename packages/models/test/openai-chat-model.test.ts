// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { OpenAIClient } from '@langchain/openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { classifyOpenAIError } from '../src/openai/classify.js';
import { openAICompatible } from '../src/openai/index.js';
import { FakeOpenAIFetch } from './support/fake-openai-fetch.js';

describe('OpenAI-compatible error classification', () => {
  it.each([
    ['http://localhost:11434/v1', 'user-device', 'unreachable'],
    ['http://127.0.0.1/v1', 'user-endpoint', 'unreachable'],
    ['https://10.0.0.1/v1', 'user-endpoint', 'unreachable'],
    ['https://172.31.0.1/v1', 'user-endpoint', 'unreachable'],
    ['https://192.168.0.1/v1', 'user-endpoint', 'unreachable'],
    ['https://169.254.1.1/v1', 'user-endpoint', 'unreachable'],
    ['https://[fd00::1]/v1', 'user-endpoint', 'unreachable'],
    ['https://[fe80::1]/v1', 'user-endpoint', 'unreachable'],
    ['https://model.local/v1', 'user-endpoint', 'unreachable'],
    ['https://[::ffff:127.0.0.1]/v1', 'user-endpoint', 'unreachable'],
    ['https://[::ffff:192.168.1.1]/v1', 'user-endpoint', 'unreachable'],
    ['https://[::ffff:169.254.1.1]/v1', 'user-endpoint', 'unreachable'],
    ['https://[::ffff:8.8.8.8]/v1', 'user-endpoint', 'unavailable'],
    ['https://public.example/v1', 'user-device', 'unreachable'],
    ['https://public.example/v1', 'user-endpoint', 'unavailable'],
    ['https://10.example/v1', 'user-endpoint', 'unavailable'],
    ['https://172.32.0.1/v1', 'user-endpoint', 'unavailable'],
    ['http://localhost/v1', 'host-server', 'unavailable'],
    ['http://localhost/v1', 'third-party', 'unavailable'],
    ['http://localhost/v1', 'in-browser', 'unavailable'],
  ] as const)('classifies a connection failure for %s (%s) as %s', (baseURL, destination, code) => {
    const result = classifyOpenAIError(new OpenAIClient.APIConnectionError({}), {
      baseURL,
      destination,
    });
    expect(result).toEqual(code === 'unreachable' ? { code } : { code, reason: 'network' });
  });

  it('keeps HTTP statuses, timeouts and aborts outside unreachable classification', () => {
    const endpoint = { baseURL: 'http://localhost/v1', destination: 'user-device' } as const;
    for (const status of [401, 403, 408, 429, 500]) {
      const error = OpenAIClient.APIError.generate(status, {}, '', new Headers());
      expect(classifyOpenAIError(error, endpoint)).toEqual(classifyOpenAIError(error));
    }
    expect(classifyOpenAIError(new OpenAIClient.APIConnectionTimeoutError(), endpoint)).toEqual({
      code: 'unavailable',
      reason: 'endpoint_failed',
    });
    expect(classifyOpenAIError(new OpenAIClient.APIUserAbortError(), endpoint)).toBeUndefined();
  });

  it('does not turn a fetch timeout or abort wrapped by the SDK into unreachable', () => {
    const endpoint = { baseURL: 'http://localhost/v1', destination: 'user-device' } as const;
    expect(
      classifyOpenAIError(
        new OpenAIClient.APIConnectionError({
          cause: new DOMException('timeout-marker', 'TimeoutError'),
        }),
        endpoint,
      ),
    ).toEqual({ code: 'unavailable', reason: 'endpoint_failed' });
    expect(
      classifyOpenAIError(
        new OpenAIClient.APIConnectionError({
          cause: new DOMException('abort-marker', 'AbortError'),
        }),
        endpoint,
      ),
    ).toBeUndefined();
  });

  it.each([
    [401, 'not_allowed'],
    [403, 'not_allowed'],
    [429, 'rate_limited'],
    [408, 'endpoint_failed'],
    [500, 'endpoint_failed'],
    [503, 'endpoint_failed'],
  ])('classifies status %s without retaining endpoint text', (status, reason) => {
    const error = OpenAIClient.APIError.generate(
      status,
      { message: 'body-marker' },
      '',
      new Headers(),
    );
    error.name = 'RenamedByAsyncCaller';
    expect(classifyOpenAIError(error)).toEqual({ code: 'unavailable', reason });
  });

  it('classifies SDK network and timeout instances without constructor names', () => {
    expect(
      classifyOpenAIError(new OpenAIClient.APIConnectionError({ message: 'body-marker' })),
    ).toEqual({ code: 'unavailable', reason: 'network' });
    expect(classifyOpenAIError(new OpenAIClient.APIConnectionTimeoutError())).toEqual({
      code: 'unavailable',
      reason: 'endpoint_failed',
    });
    expect(
      classifyOpenAIError(Object.assign(new Error('body-marker'), { name: 'TimeoutError' })),
    ).toEqual({ code: 'unavailable', reason: 'endpoint_failed' });
    expect(classifyOpenAIError({ name: 'APIConnectionError' })).toBeUndefined();
  });

  it.each([400, 404, 409, 422, 499])('leaves status %s as a provider failure', (status) => {
    expect(
      classifyOpenAIError(OpenAIClient.APIError.generate(status, {}, '', new Headers())),
    ).toBeUndefined();
  });

  it.each([new SyntaxError('body-marker'), new Error('body-marker'), undefined])(
    'leaves malformed, refused and unknown replies as provider failures',
    (error) => {
      expect(classifyOpenAIError(error)).toBeUndefined();
    },
  );

  it.each(['length', 'content_filter'])(
    'classifies the SDK parse failure for %s',
    async (finish_reason) => {
      const client = new OpenAIClient({
        apiKey: 'fake-credential',
        dangerouslyAllowBrowser: true,
        logLevel: 'off',
        fetch: async () =>
          Response.json({
            choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: '{}' } }],
          }),
      });
      const error = await client.chat.completions
        .parse({
          model: 'fake',
          messages: [{ role: 'user', content: 'hello' }],
        })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(classifyOpenAIError(error)).toBeUndefined();
    },
  );
});

const baseURL = 'https://proxy.example/v1';
const credential = 'fake-credential-canary';
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
function fixture(options: ConstructorParameters<typeof FakeOpenAIFetch>[0] = {}) {
  const fake = new FakeOpenAIFetch(options);
  const factory = openAICompatible({ baseURL, model: 'fake', fetch: fake.fetch });
  return { fake, model: factory({ credential }) };
}

describe('OpenAI-compatible chat model', () => {
  it.each([
    [undefined, 'unreachable'],
    ['user-device', 'unreachable'],
    ['user-endpoint', 'unreachable'],
    ['host-server', 'unavailable'],
    ['third-party', 'unavailable'],
    ['in-browser', 'unavailable'],
  ] as const)('classifies direct calls with destination %s as %s', async (destination, code) => {
    const fake = new FakeOpenAIFetch({ failure: true });
    const model = openAICompatible({
      baseURL: 'http://localhost/v1',
      model: 'fake',
      fetch: fake.fetch,
      ...(destination === undefined ? {} : { destination }),
    })({ credential });
    const error = await model.invoke('prompt-canary').catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('localhost');
    expect(fake.requests).toHaveLength(1);
  });

  it.each(['read-error', 'eof'] as const)(
    'keeps a local endpoint failure after an SSE response outside unreachable: %s',
    async (mode) => {
      const fake = new FakeOpenAIFetch({ truncate: true, streamFailure: mode === 'read-error' });
      const model = openAICompatible({
        baseURL: 'http://localhost/v1',
        model: 'fake',
        fetch: fake.fetch,
      })({ credential });
      await expect(
        (async () => {
          for await (const _chunk of await model.stream('hello')) {
            /* drain */
          }
        })(),
      ).rejects.toMatchObject({ name: 'ModelProviderError' });
    },
  );

  it.each([
    {
      usage: { prompt_tokens: 0, completion_tokens: 2, total_tokens: 2 },
      expected: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
    },
    {
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      expected: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
    },
    {
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      expected: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  ])('preserves reported zero usage in JSON and SSE: %j', async ({ usage, expected }) => {
    const { model } = fixture({ usage });
    expect((await model.invoke('hello')).usage_metadata).toEqual(expected);
    const chunks = [];
    for await (const chunk of await model.stream('hello')) chunks.push(chunk);
    expect(chunks.at(-1)?.usage_metadata).toEqual(expected);
    expect(chunks.filter((chunk) => chunk.usage_metadata !== undefined)).toHaveLength(1);
  });

  it('accepts text with empty tool arrays in JSON and SSE', async () => {
    const { model } = fixture({
      message: { tool_calls: [] },
      deltas: [{ role: 'assistant', content: 'hello world', tool_calls: [] }],
    });
    expect((await model.invoke('hello')).content).toBe('hello world');
    let text = '';
    for await (const chunk of await model.stream('hello')) text += chunk.text;
    expect(text).toBe('hello world');
  });

  it.each(['eof', 'read-error'] as const)(
    'fails a partial SSE %s without successful completion or endpoint text in its error',
    async (mode) => {
      const { model } = fixture({ truncate: true, streamFailure: mode === 'read-error' });
      let completed = false;
      let text = '';
      const run = (async () => {
        for await (const chunk of await model.stream('hello')) text += chunk.text;
        completed = true;
      })();
      const error = await run.catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: 'ModelProviderError' });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
        'endpoint-body-marker',
      );
      expect(error).not.toHaveProperty('cause');
      expect(text).not.toBe('');
      expect(completed).toBe(false);
    },
  );
  it.each([
    { baseURL: 'relative' },
    { baseURL: 'http://proxy.example/v1' },
    { baseURL: 'https://user:password@proxy.example' },
    { baseURL: `${baseURL}?query=1` },
    { baseURL: `${baseURL}#fragment` },
    { baseURL: 'file:///tmp/model' },
    { model: '' },
    { model: '  ' },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
    { temperature: Number.NaN },
    { headers: { Authorization: 'forbidden' } },
    { headers: { COOKIE: 'forbidden' } },
    { headers: { Host: 'forbidden' } },
  ])('rejects invalid options before any call: %j', (options) => {
    expect(() => openAICompatible({ baseURL, model: 'fake', ...options })).toThrow(
      'The model request is invalid.',
    );
  });

  it.each(['http://localhost:8080/v1', 'http://127.0.0.1/v1', 'http://[::1]/v1', baseURL])(
    'accepts %s',
    (url) => {
      expect(openAICompatible({ baseURL: url, model: 'fake' })).toBeTypeOf('function');
    },
  );

  it.each(['', undefined, 1])('rejects invalid credentials', (value) => {
    const factory = openAICompatible({ baseURL, model: 'fake' });
    expect(() => factory({ credential: value as string })).toThrow('The model request is invalid.');
  });

  it('maps text messages and sends the credential only in Authorization, even for Responses model IDs', async () => {
    const fake = new FakeOpenAIFetch();
    const model = openAICompatible({
      baseURL,
      model: 'gpt-5.6',
      fetch: fake.fetch,
      maxTokens: 10,
      headers: { 'x-host': 'test' },
    })({ credential });
    const reply = await model.invoke([
      new SystemMessage('system'),
      new HumanMessage('one'),
      new AIMessage('two'),
      new HumanMessage('three'),
    ]);
    expect(reply.content).toBe('hello world');
    expect(reply.usage_metadata).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
    expect(reply.response_metadata).toEqual({});
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`${baseURL}/chat/completions`);
    expect(request?.headers.get('authorization')).toBe(`Bearer ${credential}`);
    expect(request?.headers.get('x-host')).toBe('test');
    expect(request?.body).toMatchObject({ model: 'gpt-5.6', max_completion_tokens: 10 });
    expect(JSON.stringify(request?.body)).not.toContain(credential);
    expect(request?.url).not.toContain(credential);
    expect([...(request?.headers ?? [])].filter(([, value]) => value.includes(credential))).toEqual(
      [['authorization', `Bearer ${credential}`]],
    );
    expect(model.getLsParams()).not.toHaveProperty('ls_api_key');
  });

  it.each([
    [],
    [new AIMessage('last')],
    [new ToolMessage({ content: 'tool', tool_call_id: 'id' }), new HumanMessage('last')],
    [new HumanMessage('one'), new SystemMessage('late'), new HumanMessage('last')],
    [
      new AIMessage({ content: '', tool_calls: [{ name: 'tool', args: {}, id: 'id' }] }),
      new HumanMessage('last'),
    ],
    [
      new HumanMessage({
        content: [{ type: 'image_url', image_url: { url: 'https://image.example' } }],
      }),
    ],
  ])('rejects unsupported history before dispatch', async (...messages) => {
    const { model, fake } = fixture();
    await expect(model.invoke(messages)).rejects.toMatchObject({ code: 'invalid' });
    expect(fake.requests).toHaveLength(0);
  });

  it('streams text in order, reports final usage once, and invokes only outer token callbacks', async () => {
    const { model, fake } = fixture();
    const handleLLMNewToken = vi.fn();
    const chunks = [];
    for await (const chunk of await model.stream('hello', { callbacks: [{ handleLLMNewToken }] }))
      chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.content).join('')).toBe('hello world');
    expect(chunks.filter((chunk) => chunk.usage_metadata !== undefined)).toHaveLength(1);
    expect(chunks.at(-1)?.usage_metadata).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
    });
    expect(fake.requests[0]?.body['stream_options']).toEqual({ include_usage: true });
    expect(handleLLMNewToken.mock.calls.map(([token]) => token).join('')).toBe('hello world');
  });

  it('omits usage when the endpoint does not report it', async () => {
    const { model } = fixture({ usage: false });
    expect((await model.invoke('hello')).usage_metadata).toBeUndefined();
    for await (const chunk of await model.stream('hello'))
      expect(chunk.usage_metadata).toBeUndefined();
  });

  it('maps jsonSchema and reuses provider-level structured output validation', async () => {
    const { model, fake } = fixture({ text: '{"answer":"yes"}' });
    await model.invoke('hello', { jsonSchema: schema });
    expect(fake.requests[0]?.body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'output', strict: true, schema },
    });
    expect(
      await model.withStructuredOutput(z.object({ answer: z.string() })).invoke('hello'),
    ).toEqual({ answer: 'yes' });
    const invalid = fixture({ text: '{"answer":1}' }).model;
    await expect(
      invalid.withStructuredOutput(z.object({ answer: z.string() })).invoke('hello'),
    ).rejects.toMatchObject({ name: 'ModelProviderError' });
  });

  it.each([401, 403, 408, 429, 500, 503, 400, 404, 422])(
    'sanitizes HTTP %s and dispatches once',
    async (status) => {
      const { model, fake } = fixture({ status });
      const error = await model.invoke('prompt-canary').catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      for (const canary of [credential, 'endpoint-body-marker', 'prompt-canary'])
        expect(serialized).not.toContain(canary);
      expect(error).not.toHaveProperty('cause');
      expect(fake.requests).toHaveLength(1);
    },
  );

  it.each([
    { failure: true },
    { malformed: true },
    { text: '' },
    { text: 'not-json' },
    { finishReason: 'length' },
    { finishReason: 'content_filter' },
    { message: { content: null, refusal: 'endpoint-body-marker' } },
    {
      message: {
        tool_calls: [{ id: 'id', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      },
    },
  ])('sanitizes network and malformed replies: %j', async (options) => {
    const { model } = fixture(options);
    const error = await model
      .invoke('prompt-canary', { jsonSchema: schema })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    for (const canary of [credential, 'endpoint-body-marker', 'prompt-canary'])
      expect(serialized).not.toContain(canary);
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects tool deltas and drops reasoning from streamed messages', async () => {
    const { model } = fixture({
      deltas: [{ role: 'assistant', content: 'visible', reasoning_content: 'hidden' }],
    });
    for await (const chunk of await model.stream('hello'))
      expect(JSON.stringify(chunk)).not.toContain('hidden');
    const tools = fixture({
      deltas: [
        {
          role: 'assistant',
          tool_calls: [
            { index: 0, id: 'id', type: 'function', function: { name: 'tool', arguments: '{}' } },
          ],
        },
      ],
    }).model;
    await expect(
      (async () => {
        for await (const _ of await tools.stream('hello')) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ name: 'ModelProviderError' });
  });

  it('rejects a pre-dispatch abort with its reason without a request', async () => {
    const { model, fake } = fixture();
    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(
      model._generate([new HumanMessage('hello')], { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects a non-streaming abort during dispatch with its original reason', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    const entered = Promise.withResolvers<void>();
    const model = openAICompatible({
      baseURL,
      model: 'fake',
      fetch: async (_input, init) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('endpoint-body-marker')), {
            once: true,
          }),
        );
        throw new Error('endpoint-body-marker');
      },
    })({ credential });
    const run = model._generate([new HumanMessage('hello')], { signal: controller.signal });
    await entered.promise;
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
  });

  it('disables SDK logging and suppresses organization and project environment headers', async () => {
    vi.stubEnv('OPENAI_LOG', 'debug');
    vi.stubEnv('OPENAI_ORG_ID', 'organization-canary');
    vi.stubEnv('OPENAI_ORGANIZATION', 'organization-canary');
    vi.stubEnv('OPENAI_PROJECT_ID', 'project-canary');
    const log = vi.spyOn(console, 'debug');
    const info = vi.spyOn(console, 'log');
    try {
      const { fake, model } = fixture();
      await model.invoke('prompt-canary');
      expect(fake.requests[0]?.headers.has('openai-organization')).toBe(false);
      expect(fake.requests[0]?.headers.has('openai-project')).toBe(false);
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      log.mockRestore();
      info.mockRestore();
    }
  });

  it('rejects a mid-stream abort without successful completion and closes the body', async () => {
    const { model, fake } = fixture();
    const controller = new AbortController();
    const reason = new DOMException('Cancelled', 'AbortError');
    let ended = false;
    const run = (async () => {
      for await (const chunk of model._streamResponseChunks([new HumanMessage('hello')], {
        signal: controller.signal,
      })) {
        if (chunk.text) controller.abort(reason);
      }
      ended = true;
    })();
    await expect(run).rejects.toBe(reason);
    expect(ended).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(fake.cancellations).toBe(1);
  });
});
