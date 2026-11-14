// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import type { RunId, SessionId } from '@galaxie-ai/core';
import {
  type BaseAgent,
  BaseLlm,
  BuiltInCodeExecutor,
  BuiltInPlanner,
  Gemini,
  GoogleSearchTool,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { createAdkAdapter } from '../src/adapter.js';
import { admitRoleStrings } from '../src/admission.js';
import { type AdkHost, createHost } from '../src/host.js';
import { defineAdkEntry } from '../src/interaction.js';
import { FakeChatModel, fakeModels, fakeTrace, wordChunks } from './support/fixtures.js';

const preparation = {
  roles: ['answer', 'gemini-2.5-flash'],
  providers: { mock: { credential: false } },
};
const options = { signal: new AbortController().signal, models: preparation };

function setup() {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
  return {
    provider,
    ...createHost(
      { chatModels: { mock: provider } },
      preparation,
      () => undefined,
      () => 's',
    ),
  };
}

class ForeignModel extends BaseLlm {
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { turnComplete: true };
  }
  override async connect(): Promise<never> {
    throw new Error('Unused.');
  }
}

test.each([
  'unknown',
  'Answer',
  ' answer',
  'answer ',
  '',
  'galaxie:answer',
  'galaxie/answer',
  1,
  {},
  [],
  new Gemini({ model: 'gemini-2.5-flash', apiKey: 'unused' }),
  new ForeignModel({ model: 'foreign' }),
])('an opted-in unmappable model %j refuses before model or store access', async (model) => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  const request = vi.fn(async () => null);
  const author = new LlmAgent({ name: 'root', model: model as never });
  const before = Object.getOwnPropertyDescriptors(author);
  await expect(
    createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: author, roleStrings: true }),
      { chatModels: { mock: provider }, checkpoints: { request } },
      options,
    ),
  ).rejects.toMatchObject({ code: 'unsupported', message: 'This operation is unsupported.' });
  expect(provider.seen).toHaveLength(0);
  expect(request).not.toHaveBeenCalled();
  expect(Object.getOwnPropertyDescriptors(author)).toEqual(before);
});

test('strings stay refused for entries without the opt-in and for bare agents', async () => {
  for (const entry of [false, true]) {
    const root = new LlmAgent({ name: 'root', model: 'answer' });
    await expect(
      createAdkAdapter().prepare(
        () => (entry ? defineAdkEntry({ agent: root }) : root),
        { chatModels: { mock: setup().provider } },
        options,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(root.model).toBe('answer');
  }
});

test.each([false, 'true', null, 1])('the roleStrings field rejects %j', (roleStrings) => {
  expect(() =>
    defineAdkEntry({ agent: new LlmAgent({ name: 'root' }), roleStrings: roleStrings as never }),
  ).toThrow(expect.objectContaining({ code: 'invalid' }));
});

test('duplicate role declarations are refused only for string admission', async () => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
  const duplicate = { ...options, models: { ...preparation, roles: ['answer', 'answer'] } };
  await expect(
    createAdkAdapter().prepare(
      () =>
        defineAdkEntry({
          agent: new LlmAgent({ name: 'root', model: 'answer' }),
          roleStrings: true,
        }),
      { chatModels: { mock: provider } },
      duplicate,
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  for (const optIn of [false, true]) {
    let author: BaseAgent | undefined;
    const prepared = await createAdkAdapter().prepare(
      (host) => {
        author = new LlmAgent({ name: 'root', model: host.adk.llm('answer') });
        return defineAdkEntry({ agent: author, ...(optIn ? { roleStrings: true as const } : {}) });
      },
      { chatModels: { mock: provider } },
      duplicate,
    );
    expect(author).toBeDefined();
    await prepared.dispose();
  }
});

test('root child mixed and inherited models keep helper identities on the copied tree', () => {
  const { host, registry } = setup();
  const helper = host.adk.llm('answer');
  const inherited = new LlmAgent({ name: 'inherited' });
  const author = new LlmAgent({
    name: 'root',
    model: 'answer',
    subAgents: [inherited, new LlmAgent({ name: 'helper', model: helper })],
  });
  const copy = admitRoleStrings(author, host, preparation.roles) as LlmAgent;
  expect(copy).not.toBe(author);
  expect(copy.model).toBe(helper);
  expect(copy.subAgents[0]).not.toBe(inherited);
  expect((copy.subAgents[0] as LlmAgent).canonicalModel).toBe(helper);
  expect((copy.subAgents[1] as LlmAgent).model).toBe(helper);
  expect(registry.models.has(copy.model as object)).toBe(true);
  expect(author.model).toBe('answer');
});

test('an unmappable sibling refuses the entire tree without replacing a valid sibling', async () => {
  const valid = new LlmAgent({ name: 'valid', model: 'answer' });
  const root = new SequentialAgent({
    name: 'root',
    subAgents: [valid, new LlmAgent({ name: 'bad', model: 'unknown' })],
  });
  await expect(
    createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: root, roleStrings: true }),
      { chatModels: { mock: setup().provider } },
      options,
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(valid.model).toBe('answer');
});

test('a model-less root remains unsupported', async () => {
  await expect(
    createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: new LlmAgent({ name: 'root' }), roleStrings: true }),
      { chatModels: { mock: setup().provider } },
      options,
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
});

test.each([
  { tools: [new GoogleSearchTool()] },
  { codeExecutor: new BuiltInCodeExecutor() },
  { planner: new BuiltInPlanner({ thinkingConfig: {} }) },
])('a Gemini-looking declared role cannot admit a provider feature %j', async (extra) => {
  const provider = setup().provider;
  await expect(
    createAdkAdapter().prepare(
      () =>
        defineAdkEntry({
          agent: new LlmAgent({ name: 'root', model: 'gemini-2.5-flash', ...extra }),
          roleStrings: true,
        }),
      { chatModels: { mock: provider } },
      options,
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(provider.seen).toHaveLength(0);
});

test('a mapped Gemini-looking role fails ADK native Google Search name predicates', async () => {
  const { host } = setup();
  const copy = admitRoleStrings(
    new LlmAgent({ name: 'root', model: 'gemini-2.5-flash' }),
    host,
    preparation.roles,
  ) as LlmAgent;
  expect(copy.model).toBe(host.adk.llm('gemini-2.5-flash'));
  expect((copy.model as BaseLlm).model).toBe('galaxie:gemini-2.5-flash');
  const llmRequest: LlmRequest = {
    model: (copy.model as BaseLlm).model,
    contents: [],
    config: {},
    toolsDict: {},
    liveConnectConfig: {},
  };
  await expect(
    new GoogleSearchTool().processLlmRequest({ llmRequest, toolContext: undefined as never }),
  ).rejects.toThrow('not supported for model');
  expect(llmRequest.config?.tools).toEqual([]);
});

async function measure(shape: string, strings: boolean) {
  const provider = new FakeChatModel(
    (call) =>
      new AIMessage(
        shape === 'transfer' &&
          call.messages.some(
            (message) =>
              message.type === 'system' && String(message.content).includes('parent instruction'),
          )
          ? {
              content: '',
              tool_calls: [
                { id: 'call_0', name: 'transfer_to_agent', args: { agent_name: 'child' } },
              ],
            }
          : { content: 'done' },
      ),
    undefined,
    wordChunks,
  );
  const models = fakeModels();
  const trace = fakeTrace();
  let modelSpy: ReturnType<typeof vi.spyOn> | undefined;
  const prepared = await createAdkAdapter().prepare(
    (host: AdkHost) => {
      const model = host.adk.llm('answer');
      modelSpy = vi.spyOn(model, 'generateContentAsync');
      const leaf = (name: string): LlmAgent =>
        new LlmAgent({
          name,
          model: strings ? 'answer' : model,
          instruction: name === 'parent' ? 'parent instruction' : 'child instruction',
        });
      let root: BaseAgent;
      if (shape === 'root') root = leaf('root');
      else if (shape === 'transfer')
        root = new LlmAgent({
          name: 'parent',
          model: strings ? 'answer' : model,
          instruction: 'parent instruction',
          subAgents: [leaf('child')],
        });
      else if (shape === 'inherit')
        root = new LlmAgent({
          name: 'parent',
          model: strings ? 'answer' : model,
          subAgents: [new LlmAgent({ name: 'child' })],
        });
      else {
        const subAgents = [
          leaf('first'),
          new LlmAgent({ name: 'second', model, instruction: 'child instruction' }),
        ];
        root =
          shape === 'loop'
            ? new LoopAgent({ name: 'flow', subAgents, maxIterations: 1 })
            : shape === 'parallel'
              ? new ParallelAgent({ name: 'flow', subAgents })
              : new SequentialAgent({ name: 'flow', subAgents });
      }
      return defineAdkEntry({ agent: root, ...(strings ? { roleStrings: true as const } : {}) });
    },
    { chatModels: { mock: provider } },
    options,
  );
  try {
    const events = [];
    for await (const event of prepared.run({
      runId: 'run' as RunId,
      sessionId: 's' as SessionId,
      command: { type: 'start', input: { prompt: 'question' } },
      signal: new AbortController().signal,
      trace: trace.trace,
      models: models.port,
      limits: { steps: 10 },
      capabilities: {
        async call(): Promise<never> {
          throw new Error('No capability expected.');
        },
      },
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'output', output: 'done' });
    expect(modelSpy).toHaveBeenCalled();
    return {
      events,
      leases: models.leases,
      spans: trace.spans,
      requests: provider.seen.map((call) => ({
        messages: call.messages.map((message) => ({
          type: message.type,
          content: message.content,
        })),
        tools: call.toolSchemas,
      })),
    };
  } finally {
    await prepared.dispose();
  }
}

test.each(['root', 'sequential', 'parallel', 'loop', 'inherit', 'transfer'])(
  '%s copied execution equals helper requests streams checks labels and counters',
  async (shape) => {
    expect(await measure(shape, true)).toEqual(await measure(shape, false));
  },
);

test('an opted-in role string runs without changing the author model', async () => {
  const author = new LlmAgent({ name: 'root', model: 'answer' });
  const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
  const prepared = await createAdkAdapter().prepare(
    () => defineAdkEntry({ agent: author, roleStrings: true }),
    { chatModels: { mock: provider } },
    {
      signal: new AbortController().signal,
      models: { roles: ['answer'], providers: { mock: { credential: false } } },
    },
  );
  const events = [];
  for await (const event of prepared.run({
    runId: 'run' as RunId,
    sessionId: 's' as SessionId,
    command: { type: 'start', input: { prompt: 'question' } },
    signal: new AbortController().signal,
    trace: fakeTrace().trace,
    models: fakeModels().port,
    limits: { steps: 5 },
    capabilities: {
      async call(): Promise<never> {
        throw new Error('No capability expected.');
      },
    },
  }))
    events.push(event);
  await prepared.dispose();
  expect(events).toContainEqual({ type: 'output', output: 'done' });
  expect(author.model).toBe('answer');
});
