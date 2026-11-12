// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import type { RunId, SessionId } from '@galaxie-ai/core';
import {
  type BaseAgent,
  BuiltInCodeExecutor,
  BuiltInPlanner,
  Gemini,
  GoogleSearchTool,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { createAdkAdapter } from '../src/adapter.js';
import { type AdkHost, createHost } from '../src/host.js';
import { validateAgentTree } from '../src/validate.js';
import { FakeChatModel, fakeModels, fakeTrace, wordChunks } from './support/fixtures.js';

/* M-js ALTERNATIVE: GM1 passes, GM2 is in the isolated native file.
 * GM3/GM4 have focused equivalence evidence, not full conformance acceptance.
 * GM5 fails: a second real prepare of the same objects has a fresh registry.
 * GM6-GM8 support gates not measured: outcome fixed by GM5. The independent
 * name/refusal characterization below is not a GM7 durability claim.
 * AL-M passes through the shipped helper under the same native one-reply script.
 */
const preparation = {
  roles: ['answer', 'gemini-2.5-flash'],
  providers: { mock: { credential: false } },
};

function mapStrings(root: BaseAgent, host: AdkHost, roles: readonly string[]): void {
  // Test-local candidate only. Exact-class validation precedes property access.
  if (
    ![
      LlmAgent.prototype,
      SequentialAgent.prototype,
      ParallelAgent.prototype,
      LoopAgent.prototype,
    ].includes(Object.getPrototypeOf(root))
  )
    return;
  if (root instanceof LlmAgent && typeof root.model === 'string' && roles.includes(root.model))
    root.model = host.adk.llm(root.model);
  for (const child of root.subAgents) mapStrings(child, host, roles);
}

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

test('exact declared role strings map and unmapped neighbours refuse without calls', () => {
  const { host, registry, provider } = setup();
  const root = new LlmAgent({ name: 'root', model: 'answer' });
  mapStrings(root, host, preparation.roles);
  expect(root.model).toBe(host.adk.llm('answer'));
  expect(() => validateAgentTree(root, registry)).not.toThrow();
  for (const model of [
    'undeclared',
    'Answer',
    ' answer',
    'answer ',
    '',
    'galaxie:answer',
    'galaxie/answer',
    {},
    new Gemini({ model: 'gemini-2.5-flash', apiKey: 'unused' }),
  ]) {
    const bad = new LlmAgent({ name: 'root', model: model as never });
    mapStrings(bad, host, preparation.roles);
    expect(() => validateAgentTree(bad, registry)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  }
  const noGeminiRole = createHost(
    { chatModels: { mock: provider } },
    { ...preparation, roles: ['answer'] },
    () => undefined,
    () => 's',
  );
  const bad = new LlmAgent({ name: 'root', model: 'gemini-2.5-flash' });
  mapStrings(bad, noGeminiRole.host, ['answer']);
  expect(() => validateAgentTree(bad, noGeminiRole.registry)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
  expect(provider.seen).toHaveLength(0);
});

test('root child mixed inheritance and transfer tree validation match explicit helpers', () => {
  const { host, registry } = setup();
  for (const root of [
    new LlmAgent({ name: 'root', model: 'answer', subAgents: [new LlmAgent({ name: 'child' })] }),
    new SequentialAgent({
      name: 'root',
      subAgents: [
        new LlmAgent({ name: 'a', model: 'answer' }),
        new LlmAgent({ name: 'b', model: host.adk.llm('answer') }),
      ],
    }),
  ]) {
    mapStrings(root, host, preparation.roles);
    expect(() => validateAgentTree(root, registry)).not.toThrow();
    const models = root.subAgents.map((child) =>
      child instanceof LlmAgent ? child.model : undefined,
    );
    mapStrings(root, host, preparation.roles);
    expect(
      root.subAgents.map((child) => (child instanceof LlmAgent ? child.model : undefined)),
    ).toEqual(models);
  }
  class Foreign extends LlmAgent {}
  const foreign = new Foreign({ name: 'foreign', model: 'answer' });
  mapStrings(foreign, host, preparation.roles);
  expect(foreign.model).toBe('answer');
  expect(() => validateAgentTree(foreign, registry)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
  const partial = new SequentialAgent({
    name: 'partial',
    subAgents: [
      new LlmAgent({ name: 'a', model: 'answer' }),
      new LlmAgent({ name: 'b', model: 'unknown' }),
    ],
  });
  mapStrings(partial, host, preparation.roles);
  expect(() => validateAgentTree(partial, registry)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
  expect(() => validateAgentTree(new LlmAgent({ name: 'orphan' }), registry)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});

async function measure(mapped: boolean) {
  const provider = new FakeChatModel(
    () => new AIMessage({ content: 'done' }),
    undefined,
    wordChunks,
  );
  const leases = fakeModels();
  const prepared = await createAdkAdapter().prepare(
    (host) => {
      const root = new LlmAgent({
        name: 'root',
        model: mapped ? 'answer' : host.adk.llm('answer'),
      });
      if (mapped) mapStrings(root, host, preparation.roles);
      return root;
    },
    { chatModels: { mock: provider } },
    { signal: new AbortController().signal, models: preparation },
  );
  try {
    const events = [];
    for await (const event of prepared.run({
      runId: 'run' as RunId,
      sessionId: 's' as SessionId,
      command: { type: 'start', input: { prompt: 'question' } },
      signal: new AbortController().signal,
      trace: fakeTrace().trace,
      models: leases.port,
      limits: { steps: 5 },
      capabilities: {
        async call(): Promise<never> {
          throw new Error('No capability expected.');
        },
      },
    }))
      events.push(event);
    return {
      events,
      leases: leases.leases,
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

test('test-local mapping and the shipped helper have equal checked streaming and requests', async () => {
  const helper = await measure(false);
  expect(await measure(true)).toEqual(helper);
  expect(helper.events).toContainEqual({ type: 'output', output: 'done' });
  expect(helper.leases).toHaveLength(1);
  expect(helper.leases[0]?.checked).toContain('done');
});

test('a second real prepare of the same mapped objects fails closed instead of being idempotent', async () => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  const shared = new LlmAgent({ name: 'root', model: 'answer' });
  const factory = (host: AdkHost): BaseAgent => {
    mapStrings(shared, host, preparation.roles);
    return shared;
  };
  const adapter = createAdkAdapter();
  const options = { signal: new AbortController().signal, models: preparation };
  const first = await adapter.prepare(factory, { chatModels: { mock: provider } }, options);
  const assigned = shared.model;
  try {
    await expect(
      adapter.prepare(factory, { chatModels: { mock: provider } }, options),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      adapter.prepare(
        factory,
        { chatModels: { mock: provider } },
        { ...options, models: { ...preparation, roles: ['other'] } },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(shared.model).toBe(assigned);
    expect(provider.seen).toHaveLength(0);
  } finally {
    await first.dispose();
  }
});

test('a Gemini named role keeps a non Gemini display name and every builtin stays refused', () => {
  const { host, registry } = setup();
  const model = host.adk.llm('gemini-2.5-flash');
  expect(model.model).toBe('galaxie:gemini-2.5-flash');
  for (const extra of [
    { tools: [new GoogleSearchTool()] },
    { codeExecutor: new BuiltInCodeExecutor() },
    { planner: new BuiltInPlanner({ thinkingConfig: {} }) },
  ]) {
    const root = new LlmAgent({ name: 'root', model: 'gemini-2.5-flash', ...extra });
    mapStrings(root, host, preparation.roles);
    expect(() => validateAgentTree(root, registry)).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  }
});
