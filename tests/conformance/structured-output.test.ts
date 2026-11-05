// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  galaxieField,
  toErrorInfo,
} from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';

const schema = z.object({ answer: z.literal('yes') });
async function run(reply: string, supported = true, includeRaw = false) {
  const plain = new MockChatModel({
    hello: { id: 'plain-reply', text: 'plain provider must not run' },
  });
  const structured = new MockChatModel({ hello: { id: 'structured-reply', text: reply } });
  const generate = vi.spyOn(structured, '_generate');
  const stream = vi.spyOn(structured, '_streamResponseChunks');
  const diagnostics: DiagnosticEvent[] = [];
  const { exporter, provider } = createSpanRecorder();
  const runtime = createRuntime({
    appId: 'structured-output',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  try {
    const definition = defineAgentDefinition({
      id: 'tests/structured-output',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ text: z.string().meta(galaxieField({ label: 'public' })) }),
      models: { assistant: { modality: 'text' } },
    });
    const instance = await runtime.create(definition, {
      principalScope: 'test',
      models: {
        providers: {
          plain: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
          structured: {
            destination: 'in-browser',
            modality: 'text',
            features: supported ? ['structured-output'] : [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          assistant: { providers: ['plain', 'structured'], allow: ['in-browser'], maxTokens: 1000 },
        },
      },
      services: { chatModels: { plain, structured } },
      agent: (host) => {
        const chatModel = host.langchain.chatModel('assistant');
        const model = includeRaw
          ? chatModel.withStructuredOutput(schema, { includeRaw: true })
          : chatModel.withStructuredOutput(schema);
        return new StateGraph(
          Annotation.Root({ text: Annotation<string>, result: Annotation<unknown> }),
        )
          .addNode('respond', async (_state, config) => ({
            result: await model.invoke('hello', config),
          }))
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile();
      },
    });
    await instance.prepare();
    const { runId } = await instance.start({ text: 'input' });
    const events = await collect(instance.events(runId));
    await provider.forceFlush();
    return {
      events,
      snapshot: instance.getSnapshot(),
      diagnostics,
      spans: serializeSpans(exporter.getFinishedSpans()),
      plain,
      structured,
      schemas: [...generate.mock.calls, ...stream.mock.calls].map(([, options]) =>
        Reflect.get(options, 'jsonSchema'),
      ),
    };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

test('routed structured graph returns a parsed object using the first schema-capable provider', async () => {
  const result = await run('{"answer":"yes"}');
  expect(result.events.at(-1)).toMatchObject({
    type: 'output',
    output: { result: { answer: 'yes' } },
  });
  expect(result.snapshot.routes).toEqual({
    assistant: { providerId: 'structured', destination: 'in-browser' },
  });
  expect(result.plain.calls).toBe(0);
  expect(result.structured.calls).toBe(1);
  expect(result.schemas).toEqual([toJsonSchema(schema)]);
});

test('no schema-capable provider fails unavailable before dispatch', async () => {
  const result = await run('{"answer":"yes"}', false);
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
  expect(result.plain.calls).toBe(0);
  expect(result.structured.calls).toBe(0);
  expect(result.snapshot.routes).toBeUndefined();
});

test.each(['not json private-reply-canary', '{"answer":"private-reply-canary"}'])(
  'invalid structured reply %# never reaches failure diagnostics or spans',
  async (reply) => {
    const result = await run(reply);
    expect(result.snapshot.run).toMatchObject({
      status: 'failed',
      error: { code: 'invalid', message: toErrorInfo('invalid').message },
    });
    const errors = result.diagnostics.map((event) => event.error);
    expect(
      errors.every(
        (error) =>
          !(error instanceof Error) ||
          (error.message === toErrorInfo('invalid').message && !('cause' in error)),
      ),
    ).toBe(true);
    expect(
      JSON.stringify({
        events: result.events.filter((event) => event.type === 'error'),
        snapshot: result.snapshot,
        spans: result.spans,
        diagnostics: result.diagnostics,
      }),
    ).not.toContain('private-reply-canary');
  },
);

test('includeRaw preserves a failed reply with parsed null in graph output', async () => {
  const result = await run('not json', true, true);
  expect(result.events.at(-1)).toMatchObject({
    type: 'output',
    output: { result: { raw: { content: 'not json' }, parsed: null } },
  });
  expect(result.snapshot.run?.status).toBe('succeeded');
});
