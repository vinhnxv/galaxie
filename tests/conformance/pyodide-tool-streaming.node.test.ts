// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie-ai/core';
import { AIMessageChunk, type BaseMessage, type ToolCallChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { createMockLatch, MockChatModel } from '../../packages/models/src/mock.js';

function deltas(scenario: string): ToolCallChunk[][] {
  if (scenario === 'split-id')
    return [
      [{ index: 0, id: 'call-', name: 're', args: '{"va' }],
      [{ index: 0, id: '1', name: 'ad', args: 'lue":' }],
      [{ index: 0, args: '2}' }],
    ];
  if (scenario === 'id')
    return [
      [{ index: 0, id: 'one', name: 'read', args: '{"value":' }],
      [{ index: 0, id: 'two', args: '2}' }],
    ];
  if (scenario === 'name')
    return [
      [{ index: 0, id: 'one', name: 'read', args: '{"value":' }],
      [{ index: 0, name: 'unknown', args: '2}' }],
    ];
  if (scenario === 'arguments')
    return [
      [{ index: 0, id: 'one', name: 'read', args: '{"value":' }],
      [{ index: 0, args: 'bad}' }],
    ];
  if (scenario === 'oversized')
    return [[{ index: 0, id: 'one', name: 'read', args: 'x'.repeat(1_048_576) }]];
  const first: ToolCallChunk[][] = [
    [{ index: 0, id: 'call-1', name: scenario === 'split-name' ? 're' : 'read', args: '{"va' }],
  ];
  if (scenario === 'parallel')
    first.push([{ index: 1, id: 'other-2', name: 'other', args: '{"value":' }]);
  first.push([{ index: 0, ...(scenario === 'split-name' ? { name: 'ad' } : {}), args: 'lue":' }]);
  if (scenario === 'parallel') first.push([{ index: 1, args: '3' }]);
  first.push([{ index: 0, args: '2}' }]);
  if (scenario === 'parallel') first.push([{ index: 1, args: '}' }]);
  return first;
}

async function measure(
  scenario: string,
  serialization?: string,
): Promise<{ events: RunEvent[]; calls: unknown[]; wire: unknown[]; notifications: number }> {
  const sources: Record<string, string> = {};
  for (const name of ['tool_candidate', 'tool_streaming_candidate'])
    sources[`${name}.py`] = await readFile(
      new URL(`./cases-python/${name}.py`, import.meta.url),
      'utf8',
    );
  const fixture = await createPythonFixture({ sources, module: 'tool_streaming_candidate' });
  const latch = createMockLatch();
  const calls: unknown[] = [];
  const providerChunks = deltas(scenario);
  class DeltaModel extends MockChatModel {
    override bindTools(): this {
      return this;
    }
    override async *_streamResponseChunks(
      _messages: BaseMessage[],
      options: this['ParsedCallOptions'],
    ): AsyncGenerator<ChatGenerationChunk> {
      for (const [index, calls] of providerChunks.entries()) {
        yield new ChatGenerationChunk({
          text: '',
          message: new AIMessageChunk({ content: '', tool_call_chunks: calls }),
        });
        if (index === 0) await latch.wait(options.signal);
      }
    }
  }
  const model = new DeltaModel({});
  const runtime = createRuntime({
    appId: 'tool-stream-measurement',
    executors: [createPyodideAdapter(fixture.options)],
    outputSafety: () => 'allow',
    budgets: { payloadBytes: 4 * 1024 * 1024 },
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/tool-stream',
        version: '1',
        executor: 'langgraph-python',
        input: z.unknown(),
        models: { answer: { modality: 'text', defaultPolicy: 'remote-allowed' } },
        capabilities: {
          required: {
            'read@1': {
              kind: 'read',
              input: z.object({ value: z.number().int() }),
              output: z.string(),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent: fixture.agent,
        services: { chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming', 'tool-calling'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
        bindings: {
          'read@1': {
            kind: 'read',
            destination: 'in-browser',
            approval: 'none',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            retry: 'none',
            invoke: async (value) => {
              calls.push(value);
              return '4';
            },
          },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start(serialization ? { serialization } : { scenario });
    const events: RunEvent[] = [];
    const collecting = (async () => {
      for await (const event of instance.events(runId)) events.push(event);
    })();
    if (!serialization && scenario !== 'oversized') {
      await latch.entered;
      expect(calls).toEqual([]);
      expect(
        fixture.fromWorker
          .map((raw) => JSON.parse(raw))
          .filter((message) => message.kind === 'request' && message.op === 'capability'),
      ).toEqual([]);
      await expect
        .poll(
          () =>
            fixture.toWorker
              .map((raw) => JSON.parse(raw))
              .filter((message) => message.op === 'model-chunk').length,
        )
        .toBe(1);
      expect(calls).toEqual([]);
    }
    latch.release();
    await collecting;
    const wire = fixture.fromWorker
      .map((raw) => JSON.parse(raw))
      .filter((message) => message.kind === 'request' && message.op === 'capability');
    return {
      events,
      calls,
      wire,
      notifications: fixture.toWorker
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.op === 'model-chunk').length,
    };
  } finally {
    latch.release();
    await runtime.dispose();
    await fixture.cleanup();
  }
}

for (const scenario of ['valid', 'parallel'])
  test(`M2 valid ${scenario} deltas match the native merge without early dispatch`, async () => {
    const result = await measure(scenario);
    expect(result.events.find((event) => event.type === 'error')).toBeUndefined();
    expect(result.events.find((event) => event.type === 'output')).toMatchObject({
      output: {
        calls: [
          { id: 'call-1', name: 'read', args: { value: 2 } },
          ...(scenario === 'parallel'
            ? [{ id: 'other-2', name: 'other', args: { value: 3 } }]
            : []),
        ],
      },
    });
    expect(result.calls).toEqual(
      scenario === 'parallel' ? [{ value: 2 }, { value: 3 }] : [{ value: 2 }],
    );
    expect(result.notifications).toBe(scenario === 'parallel' ? 6 : 3);
  }, 900_000);

test.each(['split-id', 'split-name', 'id', 'name', 'arguments', 'oversized'])(
  'M2 stream refusal counterexample: %s',
  async (scenario) => {
    const result = await measure(scenario);
    expect(result.events.find((event) => event.type === 'error')).toMatchObject({
      error: { code: scenario === 'oversized' ? 'unsupported' : 'invalid' },
    });
    expect(result.calls).toEqual([]);
    expect(result.wire).toEqual([]);
  },
  900_000,
);

test.each([
  ['string', null],
  ['list', 'unsupported'],
  ['error', 'unsupported'],
  ['artifact', 'unsupported'],
  ['unknown', 'invalid'],
])(
  'M5 serialization %s retains its result',
  async (form, code) => {
    if (!form) throw new Error('Missing serialization form.');
    const result = await measure('valid', form);
    if (code === null)
      expect(result.events.find((event) => event.type === 'output')).toMatchObject({
        output: { role: 'tool', content: '4', tool_call_id: 'call-1' },
      });
    else
      expect(result.events.find((event) => event.type === 'error')).toMatchObject({
        error: { code },
      });
    expect(result.calls).toEqual([]);
    expect(result.wire).toEqual([]);
  },
  900_000,
);
