// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  AgentTool,
  BaseLlm,
  type Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';

type Reply = (request: LlmRequest, signal?: AbortSignal) => LlmResponse | Promise<LlmResponse>;

class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  readonly tag: string;
  readonly log: string[];
  readonly reply: Reply;
  constructor(tag: string, log: string[], reply: Reply) {
    super({ model: 'scripted' });
    this.tag = tag;
    this.log = log;
    this.reply = reply;
  }
  override async *generateContentAsync(
    request: LlmRequest,
    _stream?: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.log.push(this.tag);
    this.requests.push(structuredClone({ ...request, toolsDict: {} }));
    yield await this.reply(request, signal);
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}

const text = (value: string): LlmResponse => ({
  content: { role: 'model', parts: [{ text: value }] },
  turnComplete: true,
});
const call = (name: string, args: Record<string, unknown> = {}): LlmResponse => ({
  content: { role: 'model', parts: [{ functionCall: { name, args } }] },
  turnComplete: true,
});
const responses = (request: LlmRequest): unknown[] =>
  request.contents.flatMap((content) =>
    (content.parts ?? []).flatMap((part) =>
      part.functionResponse === undefined ? [] : [part.functionResponse.response],
    ),
  );

class DelegatingTool extends AgentTool {
  overrides = 0;
  override async runAsync(input: Parameters<AgentTool['runAsync']>[0]): Promise<unknown> {
    this.overrides += 1;
    return super.runAsync(input);
  }
}

async function drive(
  agent: LlmAgent,
  signal?: AbortSignal,
): Promise<{
  runner: InMemoryRunner;
  events: Event[];
}> {
  const runner = new InMemoryRunner({ agent, appName: 'native' });
  await runner.sessionService.createSession({
    appName: 'native',
    userId: 'user',
    sessionId: 'conversation',
    state: { k: 'v' },
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: 'conversation',
    newMessage: { role: 'user', parts: [{ text: 'delegate' }] },
    ...(signal === undefined ? {} : { abortSignal: signal }),
  }))
    events.push(event);
  return { runner, events };
}

function outer(tool: AgentTool, log: string[]): { agent: LlmAgent; model: ScriptedLlm } {
  const model = new ScriptedLlm('outer', log, (request) =>
    responses(request).length === 0 ? call(tool.name, { request: 'r' }) : text('outer done'),
  );
  return { agent: new LlmAgent({ name: 'outer', model, tools: [tool] }), model };
}

test('native AgentTool declaration, request order, text result and subclass override', async () => {
  const log: string[] = [];
  const innerModel = new ScriptedLlm('inner', log, () => text('inner done'));
  const inner = new LlmAgent({ name: 'worker', description: 'Do work.', model: innerModel });
  const tool = new DelegatingTool({ agent: inner });
  const root = outer(tool, log);
  const { runner, events } = await drive(root.agent);
  expect(log).toEqual(['outer', 'inner', 'outer']);
  expect(tool.overrides).toBe(1);
  expect(innerModel.requests[0]?.contents).toEqual([{ role: 'user', parts: [{ text: 'r' }] }]);
  expect(responses(root.model.requests[1]!)).toEqual([{ result: 'inner done' }]);
  expect(root.model.requests[0]?.config?.tools).toEqual([
    {
      functionDeclarations: [
        {
          name: 'worker',
          description: 'Do work.',
          parameters: {
            type: 'OBJECT',
            properties: { request: { type: 'STRING' } },
            required: ['request'],
          },
        },
      ],
    },
  ]);
  expect(events.at(-1)?.content?.parts).toEqual([{ text: 'outer done' }]);
  expect(events.some((event) => event.author === 'worker')).toBe(false);
  const session = await runner.sessionService.getSession({
    appName: 'worker',
    userId: 'user',
    sessionId: 'conversation',
  });
  expect(session).toMatchObject({ appName: 'worker', id: 'conversation' });
  expect(session?.events.some((event) => event.author === 'worker')).toBe(true);
});

test('native inner tool executes once and forwards ordinary state but not temporary deltas', async () => {
  const log: string[] = [];
  let executions = 0;
  let copied: unknown;
  const tool = new FunctionTool({
    name: 'read',
    description: 'Read.',
    parameters: z.object({}),
    execute: async (_args, context) => {
      executions += 1;
      copied = context?.state.get('k');
      context?.state.update({ changed: 'yes', 'temp:hidden': 'inner only' });
      return { value: 6 };
    },
  });
  const innerModel = new ScriptedLlm('inner', log, (request) =>
    responses(request).length === 0 ? call('read') : text('inner done'),
  );
  const inner = new LlmAgent({ name: 'worker', model: innerModel, tools: [tool] });
  const root = outer(new AgentTool({ agent: inner }), log);
  const { runner } = await drive(root.agent);
  expect(log).toEqual(['outer', 'inner', 'inner', 'outer']);
  expect(executions).toBe(1);
  expect(copied).toBe('v');
  const stored = await runner.sessionService.getSession({
    appName: 'native',
    userId: 'user',
    sessionId: 'conversation',
  });
  expect(stored?.state['changed']).toBe('yes');
  expect(stored?.state['temp:hidden']).toBeUndefined();
  expect(responses(root.model.requests.at(-1)!)).toEqual([{ result: 'inner done' }]);
});

test.each(['error', 'confirmation'] as const)(
  'native AgentTool swallows inner %s as an empty result',
  async (kind) => {
    const log: string[] = [];
    let executions = 0;
    const gated = new FunctionTool({
      name: 'gated',
      description: 'Needs confirmation.',
      requireConfirmation: true,
      execute: async () => {
        executions += 1;
        return {};
      },
    });
    const model = new ScriptedLlm('inner', log, () => {
      if (kind === 'error') throw new Error('scripted inner failure');
      return call('gated');
    });
    const inner = new LlmAgent({ name: 'worker', model, tools: [gated] });
    const root = outer(new AgentTool({ agent: inner }), log);
    const { events } = await drive(root.agent);
    // Neither swallow is acceptable for a galaxie fatal error or nested pause.
    expect(log).toEqual(['outer', 'inner', 'outer']);
    expect(responses(root.model.requests[1]!)).toEqual([{ result: '' }]);
    expect(events.at(-1)?.content?.parts).toEqual([{ text: 'outer done' }]);
    expect(executions).toBe(0);
  },
);

test('native two AgentTool calls return both results in one outer response event', async () => {
  const log: string[] = [];
  const inner = new LlmAgent({
    name: 'worker',
    model: new ScriptedLlm('inner', log, (request) =>
      text(
        request.contents.filter((content) => content.role === 'user').at(-1)?.parts?.[0]?.text ??
          'missing',
      ),
    ),
  });
  const model = new ScriptedLlm('outer', log, (request) =>
    responses(request).length > 0
      ? text('done')
      : {
          content: {
            role: 'model',
            parts: ['one', 'two'].map((request) => ({
              functionCall: { name: 'worker', args: { request } },
            })),
          },
          turnComplete: true,
        },
  );
  const { events } = await drive(
    new LlmAgent({ name: 'outer', model, tools: [new AgentTool({ agent: inner })] }),
  );
  expect(log).toEqual(['outer', 'inner', 'inner', 'outer']);
  expect(responses(model.requests[1]!)).toEqual([{ result: 'one' }, { result: 'two' }]);
  expect(
    events.filter((event) => event.content?.parts?.some((part) => part.functionResponse)),
  ).toHaveLength(1);
});

test('native outer cancellation reaches the waiting inner model', async () => {
  const log: string[] = [];
  const controller = new AbortController();
  let reached: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let aborted = false;
  const inner = new LlmAgent({
    name: 'worker',
    model: new ScriptedLlm('inner', log, async (_request, signal) => {
      reached?.();
      await new Promise<void>((resolve) =>
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return text('late');
    }),
  });
  const root = outer(new AgentTool({ agent: inner }), log);
  const pending = drive(root.agent, controller.signal);
  await started;
  controller.abort();
  await pending;
  expect(aborted).toBe(true);
  expect(log).toEqual(['outer', 'inner']);
});
