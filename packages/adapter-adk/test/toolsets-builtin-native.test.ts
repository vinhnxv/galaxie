// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import * as adk from '@google/adk';
import {
  BaseCodeExecutor,
  BaseLlm,
  type BaseTool,
  BaseToolset,
  BuiltInCodeExecutor,
  BuiltInPlanner,
  FunctionTool,
  GoogleSearchTool,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  PlanReActPlanner,
  type ReadonlyContext,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';

/* NT1: JS expands per request; filters belong to the toolset implementation.
 * Runner has no close method; it closes toolsets at invocation end. NN1: provider config,
 * no local tool call. NX1: only builtin code execution is in the web surface.
 * NL1: thinking config and PlanReAct retagging differ from planner-less output.
 */
class Scripted extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  readonly replies: LlmResponse[];
  constructor(replies: LlmResponse[], name = 'scripted') {
    super({ model: name });
    this.replies = replies;
  }
  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(structuredClone({ ...request, toolsDict: {} }));
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error('Script exhausted.');
    yield reply;
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}
const text = (value: string): LlmResponse => ({
  content: { role: 'model', parts: [{ text: value }] },
  turnComplete: true,
});

class StaticTools extends BaseToolset {
  calls = 0;
  closed = 0;
  readonly tools: BaseTool[];
  constructor(
    tools: BaseTool[],
    filter: string[] | ((tool: BaseTool, context: ReadonlyContext) => boolean) = [],
    prefix?: string,
  ) {
    super(filter, prefix);
    this.tools = tools;
  }
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    this.calls += 1;
    return this.tools.filter((tool) => this.isToolSelected(tool, context as ReadonlyContext));
  }
  override async close(): Promise<void> {
    this.closed += 1;
  }
}
async function converse(root: LlmAgent) {
  const runner = new InMemoryRunner({ agent: root, appName: 'spike' });
  const session = await runner.sessionService.createSession({ appName: 'spike', userId: 'user' });
  const events = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'question' }] },
  }))
    events.push(event);
  return {
    events,
    runner,
    final: events
      .filter(isFinalResponse)
      .flatMap((event) => event.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join(''),
  };
}

for (const filter of ['none', 'list', 'callable']) {
  test(`native toolset ${filter} filtering expands on every request and cleanup runs at invocation end`, async () => {
    const calls: number[] = [];
    const contexts: unknown[] = [];
    const double = new FunctionTool({
      name: 'double',
      description: 'Double.',
      parameters: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        calls.push(value);
        return { value: value * 2 };
      },
    });
    const other = new FunctionTool({
      name: 'other',
      description: 'Other.',
      execute: async () => ({}),
    });
    const group = new StaticTools(
      [double, other],
      filter === 'none'
        ? []
        : filter === 'list'
          ? ['double']
          : (tool, context) => {
              contexts.push(context);
              return tool.name === 'double';
            },
      'suite',
    );
    const model = new Scripted([
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'double', args: { value: 21 } } }],
        },
        turnComplete: true,
      },
      text('done'),
    ]);
    const result = await converse(new LlmAgent({ name: 'root', model, tools: [group] }));
    expect(result.final).toBe('done');
    expect(calls).toEqual([21]);
    expect(group.calls).toBeGreaterThanOrEqual(2);
    expect(model.requests).toHaveLength(2);
    expect(
      model.requests[0]?.config?.tools?.flatMap((tool) =>
        'functionDeclarations' in tool
          ? (tool.functionDeclarations?.map((declaration) => declaration.name) ?? [])
          : [],
      ),
    ).toEqual(filter === 'none' ? ['double', 'other'] : ['double']);
    // BaseToolset.prefix is metadata here: JS does not prefix these tool names.
    expect(group.prefix).toBe('suite');
    expect(Reflect.get(result.runner, 'close')).toBeUndefined();
    expect(group.closed).toBe(1);
    if (filter === 'callable')
      expect(contexts.every((context) => context !== undefined)).toBe(true);
  });
}

test('native search changes only provider config and non Gemini names fail before the model', async () => {
  const model = new Scripted([text('done')], 'gemini-2.5-flash');
  expect(
    (await converse(new LlmAgent({ name: 'root', model, tools: [new GoogleSearchTool()] }))).final,
  ).toBe('done');
  expect(model.requests).toHaveLength(1);
  expect(model.requests[0]?.config?.tools).toEqual([{ googleSearch: {} }]);
  for (const name of ['scripted', 'galaxie:gemini-2.5-flash']) {
    const foreign = new Scripted([text('done')], name);
    await expect(
      converse(new LlmAgent({ name: 'root', model: foreign, tools: [new GoogleSearchTool()] })),
    ).rejects.toThrow('not supported');
    expect(foreign.requests).toHaveLength(0);
  }
});

test('native builtin executor and thinking planner contribute provider settings', async () => {
  const code = new Scripted([text('done')], 'gemini-2.5-flash');
  await converse(
    new LlmAgent({ name: 'root', model: code, codeExecutor: new BuiltInCodeExecutor() }),
  );
  expect(code.requests[0]?.config?.tools).toEqual([{ codeExecution: {} }]);
  const thinking = new Scripted([text('done')], 'gemini-2.5-flash');
  await converse(
    new LlmAgent({
      name: 'root',
      model: thinking,
      planner: new BuiltInPlanner({ thinkingConfig: { thinkingBudget: 128 } }),
    }),
  );
  expect(thinking.requests[0]?.config?.thinkingConfig).toEqual({ thinkingBudget: 128 });
  expect('UnsafeLocalCodeExecutor' in adk).toBe(false);
  expect('ContainerCodeExecutor' in adk).toBe(false);
  expect('LOAD_WEB_PAGE' in adk).toBe(false);
});

test('native PlanReAct changes thought parts and the final answer under the same script', async () => {
  const reply = '/*PLANNING*/think/*FINAL_ANSWER*/done';
  const planned = await converse(
    new LlmAgent({
      name: 'root',
      model: new Scripted([text(reply)]),
      planner: new PlanReActPlanner(),
    }),
  );
  expect(planned.final).toBe('done');
  expect(planned.events.flatMap((event) => event.content?.parts ?? [])).toContainEqual({
    text: '/*PLANNING*/think/*FINAL_ANSWER*/',
    thought: true,
  });
  expect(
    (await converse(new LlmAgent({ name: 'root', model: new Scripted([text(reply)]) }))).final,
  ).toBe(reply);
});

test('a native code executor callback shares the author global scope without isolation', async () => {
  const key = '__adk_spike_sentinel';
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Reflect.set(globalThis, key, 'author-sentinel');
  class AuthorExecutor extends BaseCodeExecutor {
    override async executeCode(): Promise<{ stdout: string; stderr: string; outputFiles: [] }> {
      return { stdout: String(Reflect.get(globalThis, key)), stderr: '', outputFiles: [] };
    }
  }
  try {
    const executor = new AuthorExecutor();
    // Trusted test code only; no eval, subprocess or generated JavaScript runs.
    expect((await executor.executeCode()).stdout).toBe('author-sentinel');
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, previous);
  }
});
