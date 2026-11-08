// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { type CapabilityBindingPolicy, type CapabilityPort, GalaxieError } from '@galaxie-ai/core';
import { InMemoryRunner, LlmAgent, ParallelAgent, type SequentialAgent } from '@google/adk';
import { AIMessage, type ToolMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createHost, validServices } from '../src/host.js';
import { FakeChatModel, fakeModels, fakeRun, type Reply } from './support/fixtures.js';

const readPolicy: CapabilityBindingPolicy = {
  kind: 'read',
  approval: 'none',
  confirmationAvailable: false,
};
const policy = vi.hoisted<{ current: CapabilityBindingPolicy | undefined }>(() => ({
  current: undefined,
}));
vi.mock('@galaxie-ai/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@galaxie-ai/core')>()),
  capabilityBindingPolicy: vi.fn(() => policy.current),
}));

interface CapabilityCall {
  readonly name: string;
  readonly input: unknown;
  readonly effectScope: string | undefined;
}

function capabilities(
  handler: (call: CapabilityCall) => unknown | Promise<unknown> = () => ({ ok: true }),
): { readonly port: CapabilityPort; readonly calls: CapabilityCall[] } {
  const calls: CapabilityCall[] = [];
  return {
    calls,
    port: {
      async call(name, input, options): Promise<unknown> {
        const call = { name, input, effectScope: options?.effectScope };
        calls.push(call);
        return handler(call);
      },
    },
  };
}

function build(reply: Reply, port: CapabilityPort) {
  policy.current = readPolicy;
  const model = new FakeChatModel(reply);
  const { port: models } = fakeModels();
  const { run } = fakeRun(models, { capabilities: port });
  const { host, registry } = createHost(
    { chatModels: { mock: model } },
    { roles: ['agent'], providers: { mock: { credential: false } } },
    () => run,
    () => 'conv-1',
  );
  const search = host.adk.capabilityTool('docs.search@1', {
    description: 'Search documents.',
    parameters: z.object({ q: z.string() }),
  });
  return { host, registry, run, model, search };
}

async function drive(agent: LlmAgent | SequentialAgent | ParallelAgent): Promise<string> {
  const runner = new InMemoryRunner({ agent, appName: 'host-test' });
  let text = '';
  for await (const event of runner.runEphemeral({
    userId: 'u',
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  }))
    for (const part of event.content?.parts ?? []) text += part.text ?? '';
  return text;
}

const callThenAnswer =
  (...calls: { name: string; args: Record<string, unknown> }[]): Reply =>
  (seen) =>
    seen.messages.some((message) => message.type === 'tool')
      ? new AIMessage({ content: 'answer' })
      : new AIMessage({
          content: '',
          tool_calls: calls.map((call) => ({ id: 'call_0', ...call })),
        });

test('a capability tool calls the broker with a positional effect scope, not the call ID', async () => {
  const { port, calls } = capabilities();
  const { host, search } = build(
    callThenAnswer(
      { name: 'docs_search_1', args: { q: 'a' } },
      { name: 'docs_search_1', args: { q: 'b' } },
    ),
    port,
  );
  const agent = new LlmAgent({
    name: 'agent',
    model: host.adk.llm('agent'),
    instruction: 'x',
    tools: [search],
  });
  expect(await drive(agent)).toContain('answer');
  expect(calls.map((call) => call.input)).toEqual([{ q: 'a' }, { q: 'b' }]);
  expect(calls.map((call) => call.effectScope)).toEqual([
    'adk/conv-1/root/0/0',
    'adk/conv-1/root/0/1',
  ]);
});

test('a second tool-call turn advances the branch-local index', async () => {
  const { port, calls } = capabilities();
  let turn = 0;
  const { host, search } = build((seen) => {
    const answered = seen.messages.filter((message) => message.type === 'tool').length;
    if (answered >= 2) return new AIMessage({ content: 'done' });
    turn += 1;
    return new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_0', name: 'docs_search_1', args: { q: `turn${turn}` } }],
    });
  }, port);
  const agent = new LlmAgent({
    name: 'agent',
    model: host.adk.llm('agent'),
    instruction: 'x',
    tools: [search],
  });
  await drive(agent);
  expect(calls.map((call) => call.effectScope)).toEqual([
    'adk/conv-1/root/0/0',
    'adk/conv-1/root/1/0',
  ]);
});

test('a denied capability returns a fixed error to the model and the run continues', async () => {
  const { port } = capabilities(() => {
    throw new GalaxieError('denied', 'secret detail that must not reach the model');
  });
  const { host, search, model, run } = build(
    callThenAnswer({ name: 'docs_search_1', args: { q: 'a' } }),
    port,
  );
  const agent = new LlmAgent({
    name: 'agent',
    model: host.adk.llm('agent'),
    instruction: 'x',
    tools: [search],
  });
  expect(await drive(agent)).toContain('answer');
  const reply = model.seen
    .at(-1)
    ?.messages.find((message) => message.type === 'tool') as ToolMessage;
  expect(reply.content).toBe('{"error":"Policy denied the request."}');
  expect(JSON.stringify(model.seen)).not.toContain('secret detail');
  expect(run.failure).toBeUndefined();
});

test('an unavailable capability is recorded as the run failure and not shown to the model', async () => {
  const { port } = capabilities(() => {
    throw new GalaxieError('unavailable', 'backend host db.internal:5432 refused');
  });
  const { host, search, model, run } = build(
    callThenAnswer({ name: 'docs_search_1', args: { q: 'a' } }),
    port,
  );
  const agent = new LlmAgent({
    name: 'agent',
    model: host.adk.llm('agent'),
    instruction: 'x',
    tools: [search],
  });
  await drive(agent).catch(() => '');
  expect(run.failure?.code).toBe('unavailable');
  expect(run.signal.aborted).toBe(true);
  expect(JSON.stringify(model.seen)).not.toContain('db.internal');
  expect(model.seen).toHaveLength(1);
});

test('sub-agents on parallel branches get distinct scopes', async () => {
  const { port, calls } = capabilities();
  const { host, search } = build(callThenAnswer({ name: 'docs_search_1', args: { q: 'x' } }), port);
  const llm = host.adk.llm('agent');
  const make = (name: string): LlmAgent =>
    new LlmAgent({ name, model: llm, instruction: 'x', tools: [search] });
  await drive(new ParallelAgent({ name: 'fan', subAgents: [make('left'), make('right')] }));
  const scopes = calls.map((call) => call.effectScope);
  expect(new Set(scopes).size).toBe(2);
  expect(scopes.every((scope) => scope?.startsWith('adk/conv-1/'))).toBe(true);
  expect(scopes.some((scope) => scope?.includes('left'))).toBe(true);
  expect(scopes.some((scope) => scope?.includes('right'))).toBe(true);
});

test.each([
  { name: 'no broker policy', current: undefined },
  { name: 'a write without approval', current: { ...readPolicy, kind: 'write' as const } },
  {
    name: 'a device capability without approval',
    current: { ...readPolicy, kind: 'device' as const },
  },
  {
    name: 'a write that needs a confirmation but has none configured',
    current: { kind: 'write' as const, approval: 'confirm' as const, confirmationAvailable: false },
  },
])(
  'the helper refuses $name with the fixed error and never calls the capability',
  async (entry) => {
    const { port, calls } = capabilities();
    const { host, search, model, run } = build(
      callThenAnswer({ name: 'docs_search_1', args: { q: 'private-canary-argument' } }),
      port,
    );
    policy.current = entry.current;
    const agent = new LlmAgent({
      name: 'agent',
      model: host.adk.llm('agent'),
      instruction: 'x',
      tools: [search],
    });
    expect(await drive(agent)).toContain('answer');
    expect(calls).toHaveLength(0);
    const reply = model.seen
      .at(-1)
      ?.messages.find((message) => message.type === 'tool') as ToolMessage;
    expect(reply.content).toBe('{"error":"The request is invalid."}');
    expect(reply.content).not.toContain('docs');
    expect(run.failure).toBeUndefined();
  },
);

test('a confirmed write with a configured confirmation reaches the broker once', async () => {
  const { port, calls } = capabilities();
  const { host, search } = build(callThenAnswer({ name: 'docs_search_1', args: { q: 'a' } }), port);
  policy.current = { kind: 'write', approval: 'confirm', confirmationAvailable: true };
  const agent = new LlmAgent({
    name: 'agent',
    model: host.adk.llm('agent'),
    instruction: 'x',
    tools: [search],
  });
  expect(await drive(agent)).toContain('answer');
  expect(calls.map((call) => call.input)).toEqual([{ q: 'a' }]);
});

test('host.capabilities.call forwards the run signal and records fatal errors', async () => {
  const { port } = capabilities(() => {
    throw new GalaxieError('unavailable', 'x');
  });
  const { host, run } = build(() => new AIMessage({ content: 'x' }), port);
  await expect(host.capabilities.call('docs.search@1', {})).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(run.failure?.code).toBe('unavailable');
  await expect(host.capabilities.call('docs.search@1', {})).rejects.toMatchObject({
    code: 'unavailable',
  });
});

test('a tool name that is not a valid function name, and an unknown role, are rejected', () => {
  const { host } = build(() => new AIMessage({ content: 'x' }), capabilities().port);
  expect(() =>
    host.adk.capabilityTool('x', {
      toolName: '1bad name',
      description: 'd',
      parameters: z.object({}),
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid' }));
  expect(() => host.adk.llm('missing')).toThrow(expect.objectContaining({ code: 'unavailable' }));
});

test('providers must match the model preparation', () => {
  const model = new FakeChatModel(() => new AIMessage({ content: 'x' }));
  const create = (providers: Record<string, { credential: boolean }>) => () =>
    createHost(
      { chatModels: { mock: model } },
      { roles: ['agent'], providers },
      () => undefined,
      () => 'c',
    );
  expect(create({ mock: { credential: false } })).not.toThrow();
  expect(create({ other: { credential: false } })).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
  expect(create({ mock: { credential: true } })).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
});

test('service validation accepts chat models and credential factories only', () => {
  const model = new FakeChatModel(() => new AIMessage({ content: 'x' }));
  expect(validServices({ chatModels: { a: model, b: () => model } })).toBe(true);
  for (const bad of [
    undefined,
    {},
    { chatModels: [] },
    { chatModels: { a: 1 } },
    { chatModels: { a: {} } },
  ])
    expect(validServices(bad)).toBe(false);
});
