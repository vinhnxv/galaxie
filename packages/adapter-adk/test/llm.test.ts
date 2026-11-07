// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { GalaxieError } from '@galaxie/core';
import { FunctionTool, type LlmRequest, type LlmResponse, requestInputTool } from '@google/adk';
import {
  AIMessage,
  HumanMessage,
  type StandardMessageStructure,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { GalaxieLlm } from '../src/llm.js';
import type { RunState } from '../src/run.js';
import {
  FakeChatModel,
  type FakeModelsOptions,
  fakeModels,
  fakeRun,
  type Reply,
  wordChunks,
} from './support/fixtures.js';

type Contents = LlmRequest['contents'];

function request(
  contents: Contents,
  config: LlmRequest['config'] = {},
  toolsDict = {},
): LlmRequest {
  return { contents, config, liveConnectConfig: {}, toolsDict };
}
const user = (text: string): Contents[number] => ({ role: 'user', parts: [{ text }] });
const declare = (...names: string[]): NonNullable<NonNullable<LlmRequest['config']>['tools']> => [
  { functionDeclarations: names.map((name) => ({ name, description: `${name} tool` })) },
];

function setup(
  reply: Reply,
  options: FakeModelsOptions & { steps?: number; trusted?: (tool: unknown) => boolean } = {},
): {
  llm: GalaxieLlm;
  run: RunState;
  model: FakeChatModel;
  leases: ReturnType<typeof fakeModels>['leases'];
} {
  const model = new FakeChatModel(reply);
  const { port, leases } = fakeModels(options);
  const { run } = fakeRun(port, options.steps === undefined ? {} : { steps: options.steps });
  const llm = new GalaxieLlm({
    role: 'agent',
    providers: { mock: model },
    active: () => run,
    trusted: options.trusted ?? (() => false),
  });
  return { llm, run, model, leases };
}

async function generate(llm: GalaxieLlm, input: LlmRequest): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(input, false)) responses.push(response);
  return responses;
}

test.each([false, true])(
  'the lower caller or lease output limit reaches every provider call (stream=%s)',
  async (stream) => {
    const model = new FakeChatModel(
      () => new AIMessage({ content: 'hello' }),
      undefined,
      wordChunks,
    );
    const { port, leases } = fakeModels({ maxTokens: 64 });
    const { run } = fakeRun(port, { steps: 28 });
    const llm = new GalaxieLlm({
      role: 'agent',
      providers: { mock: model },
      active: () => run,
      trusted: () => false,
    });
    for (const tools of [undefined, declare('lookup')]) {
      for (const maxOutputTokens of [undefined, 16, 128, 0, -5, 16.5, Number.NaN]) {
        const input = request([user('hi')], {
          stopSequences: ['END'],
          ...(tools === undefined ? {} : { tools }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        });
        const responses = [];
        for await (const response of llm.generateContentAsync(input, stream))
          responses.push(response);
        expect(responses.at(-1)?.turnComplete).toBe(true);
        expect(model.seen.at(-1)?.options).toMatchObject({
          maxTokens: maxOutputTokens === 16 ? 16 : 64,
          stop: ['END'],
          signal: run.signal,
        });
      }
    }
    expect(model.seen).toHaveLength(14);
    expect(leases.every((lease) => lease.ended.length === 1 && lease.failed === 0)).toBe(true);
  },
);

test('a text reply becomes one text part with usage that adds up', async () => {
  const { llm, leases } = setup(
    () =>
      new AIMessage<StandardMessageStructure>({
        content: 'hello',
        usage_metadata: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      }),
  );
  const [response, ...rest] = await generate(llm, request([user('hi')]));
  expect(rest).toEqual([]);
  expect(response?.content).toEqual({ role: 'model', parts: [{ text: 'hello' }] });
  expect(response?.usageMetadata).toEqual({
    promptTokenCount: 4,
    candidatesTokenCount: 3,
    totalTokenCount: 7,
  });
  expect(leases[0]?.ended).toEqual([{ inputTokens: 4, outputTokens: 3 }]);
});

test('a system instruction, user turn, function call and function response map in OpenAI order', async () => {
  const { llm, model } = setup(() => new AIMessage({ content: 'done' }));
  await generate(
    llm,
    request(
      [
        user('look it up'),
        {
          role: 'model',
          parts: [{ functionCall: { id: 'galaxie-0', name: 'lookup', args: { q: 1 } } }],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'galaxie-0', name: 'lookup', response: { found: true } } },
          ],
        },
      ],
      { systemInstruction: 'Be brief.', tools: declare('lookup') },
    ),
  );
  const messages = model.seen[0]?.messages ?? [];
  expect(messages.map((message) => message.type)).toEqual(['system', 'human', 'ai', 'tool']);
  expect(messages[0]).toBeInstanceOf(SystemMessage);
  expect(messages[1]).toBeInstanceOf(HumanMessage);
  expect((messages[2] as AIMessage).tool_calls).toEqual([
    { id: 'galaxie-0', name: 'lookup', args: { q: 1 }, type: 'tool_call' },
  ]);
  expect(messages[3]).toBeInstanceOf(ToolMessage);
  expect((messages[3] as ToolMessage).tool_call_id).toBe('galaxie-0');
  expect(messages[3]?.content).toBe('{"found":true}');
  expect(model.seen[0]?.tools).toEqual(['lookup']);
});

test('provider call IDs are replaced by IDs derived from the history, unique across turns', async () => {
  const { llm } = setup(
    () =>
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call_0', name: 'lookup', args: { n: 1 } },
          { id: 'call_0', name: 'lookup', args: { n: 2 } },
        ],
      }),
  );
  const first = await generate(llm, request([user('go')], { tools: declare('lookup') }));
  const calls = (first[0]?.content?.parts ?? []).flatMap((part) =>
    part.functionCall === undefined ? [] : [part.functionCall],
  );
  expect(calls.map((call) => call.id)).toEqual(['galaxie-0', 'galaxie-1']);
  const second = await generate(
    llm,
    request(
      [
        user('go'),
        { role: 'model', parts: calls.map((functionCall) => ({ functionCall })) },
        {
          role: 'user',
          parts: calls.map((call) => ({
            functionResponse: { id: call.id ?? '', name: 'lookup', response: {} },
          })),
        },
      ],
      { tools: declare('lookup') },
    ),
  );
  const ids = [
    ...calls.map((call) => call.id),
    ...(second[0]?.content?.parts?.map((part) => part.functionCall?.id) ?? []),
  ];
  expect(new Set(ids).size).toBe(4);
});

test('a call to a tool that was not offered fails invalid and is recorded', async () => {
  const { llm, run, leases } = setup(
    () => new AIMessage({ content: '', tool_calls: [{ id: 'x', name: 'other', args: {} }] }),
  );
  await expect(
    generate(llm, request([user('go')], { tools: declare('lookup') })),
  ).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(run.failure?.code).toBe('invalid');
  expect(leases[0]?.failed).toBe(1);
  expect(leases[0]?.ended).toEqual([]);
});

test('Gemini-style declarations reach the provider as JSON Schema', async () => {
  const echo = new FunctionTool({
    name: 'echo',
    description: 'Echo a value.',
    parameters: z.object({
      value: z.string().min(2).max(9),
      count: z.number().int().optional(),
      tags: z.array(z.string()).nullable(),
      mode: z.enum(['a', 'b']),
    }),
    execute: async () => ({}),
  });
  const { llm, model } = setup(() => new AIMessage({ content: 'ok' }));
  await generate(
    llm,
    request([user('go')], {
      tools: [
        { functionDeclarations: [echo._getDeclaration(), requestInputTool._getDeclaration()] },
      ],
    }),
  );
  const [echoSchema, inputSchema] = model.seen[0]?.toolSchemas ?? [];
  expect(echoSchema?.['parameters']).toEqual({
    type: 'object',
    properties: {
      value: { type: 'string', minLength: 2, maxLength: 9 },
      count: { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
      tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['value', 'tags', 'mode'],
  });
  expect(inputSchema?.['name']).toBe('adk_request_input');
  expect(JSON.stringify(inputSchema?.['parameters'])).not.toMatch(/"(OBJECT|STRING)"/);
});

test('parametersJsonSchema is used as given when present', async () => {
  const schema = {
    type: 'object',
    properties: { q: { type: 'string' } },
    additionalProperties: false,
  };
  const { llm, model } = setup(() => new AIMessage({ content: 'ok' }));
  await generate(
    llm,
    request([user('go')], {
      tools: [{ functionDeclarations: [{ name: 'search', parametersJsonSchema: schema }] }],
    }),
  );
  expect(model.seen[0]?.toolSchemas[0]?.['parameters']).toEqual(schema);
});

test('a response schema reaches the provider as structured output, alone and with tools', async () => {
  const responseSchema = {
    type: 'OBJECT',
    properties: { answer: { type: 'STRING' } },
    required: ['answer'],
  };
  const alone = setup(() => new AIMessage({ content: '{"answer":"x"}' }));
  await generate(
    alone.llm,
    request([user('go')], { responseSchema, responseMimeType: 'application/json' }),
  );
  expect(alone.model.seen[0]?.options['jsonSchema']).toEqual({
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  });
  expect(alone.leases[0]?.requires).toEqual(['structured-output']);
  expect(alone.model.seen[0]?.options['maxTokens']).toBe(64);
  const together = setup(() => new AIMessage({ content: '{}' }));
  await generate(together.llm, request([user('go')], { responseSchema, tools: declare('lookup') }));
  expect(together.leases[0]?.requires).toEqual(['tool-calling', 'structured-output']);
  expect(together.model.seen[0]?.options['jsonSchema']).toBeDefined();
  expect(together.model.seen[0]?.options['maxTokens']).toBe(64);
});

test('a tool outside the host registry fails unsupported before any lease', async () => {
  const outsider = new FunctionTool({ name: 'echo', description: 'x', execute: async () => ({}) });
  const { llm, run, leases } = setup(() => new AIMessage({ content: 'ok' }));
  await expect(generate(llm, request([user('go')], {}, { echo: outsider }))).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(run.failure?.code).toBe('unsupported');
  expect(leases).toEqual([]);
});

test('registered tools and ADK internal tools pass the registry check', async () => {
  const known = new FunctionTool({ name: 'echo', description: 'x', execute: async () => ({}) });
  const internal = new FunctionTool({
    name: 'set_model_response',
    description: 'x',
    execute: async () => ({}),
  });
  const { llm } = setup(() => new AIMessage({ content: 'ok' }), {
    trusted: (tool) => tool === known,
  });
  const responses = await generate(
    llm,
    request([user('go')], {}, { echo: known, set_model_response: internal }),
  );
  expect(responses).toHaveLength(1);
});

test('a block, an unavailable provider and an exhausted step budget each record the failure slot', async () => {
  const blocked = setup(() => new AIMessage({ content: 'the secret canary' }), { block: 'canary' });
  await expect(generate(blocked.llm, request([user('go')]))).rejects.toMatchObject({
    code: 'denied',
  });
  expect(blocked.run.failure?.code).toBe('denied');
  expect(blocked.run.signal.aborted).toBe(true);
  expect(blocked.leases[0]?.failed).toBe(1);

  const unavailable = setup(() => new AIMessage({ content: 'ok' }), { providerId: 'missing' });
  await expect(generate(unavailable.llm, request([user('go')]))).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(unavailable.run.failure?.code).toBe('unavailable');

  const budget = setup(() => new AIMessage({ content: 'ok' }), { steps: 1 });
  await generate(budget.llm, request([user('one')]));
  await expect(generate(budget.llm, request([user('two')]))).rejects.toMatchObject({
    code: 'budget_exceeded',
  });
  expect(budget.run.failure?.code).toBe('budget_exceeded');
  expect(budget.model.seen).toHaveLength(1);
});

test('a provider that cannot call tools fails unsupported without another provider being tried', async () => {
  const { llm, run, model, leases } = setup(() => new AIMessage({ content: 'ok' }), {
    beginError: new GalaxieError('unsupported', 'The requested capability is unsupported.'),
  });
  await expect(
    generate(llm, request([user('go')], { tools: declare('lookup') })),
  ).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(run.failure?.code).toBe('unsupported');
  expect(model.seen).toEqual([]);
  expect(leases).toEqual([]);
});

test('an inlineData part in the request fails unsupported', async () => {
  const { llm, run, model } = setup(() => new AIMessage({ content: 'ok' }));
  await expect(
    generate(
      llm,
      request([{ role: 'user', parts: [{ inlineData: { data: 'AA==', mimeType: 'image/png' } }] }]),
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(run.failure?.code).toBe('unsupported');
  expect(model.seen).toEqual([]);
});

test('call IDs and names are checked as separate strings, and a live connection is unsupported', async () => {
  const { llm, leases } = setup(
    () =>
      new AIMessage({
        content: 'x',
        tool_calls: [{ id: 'call-id', name: 'lookup', args: { a: 1 } }],
      }),
  );
  await generate(llm, request([user('go')], { tools: declare('lookup') }));
  expect(leases[0]?.checked).toEqual(['x\n{"a":1}\ncall-id\nlookup']);
  const second = setup(() => new AIMessage({ content: 'x' }));
  await expect(second.llm.connect()).rejects.toMatchObject({ code: 'unsupported' });
});
