// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, type LangGraphAgent } from '@galaxie-ai/adapter-langgraph';
import {
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  type OutputSafetyHook,
  type RunEvent,
} from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import type { BaseMessage } from '@langchain/core/messages';
import {
  Annotation,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import {
  assertSpanTree,
  createSpanRecorder,
  serializeSpans,
} from '../../packages/core/test/span-tree.js';
import { normalize } from './support/normalize.js';

const sentinel = 'withheld-reply-canary-0b3f';
const reply = `first ${sentinel} third`;
const state = Annotation.Root({ input: Annotation<string>, answer: Annotation<string> });

async function run(hook?: OutputSafetyHook) {
  const diagnostics: DiagnosticEvent[] = [];
  const { exporter, provider } = createSpanRecorder();
  const runtime = createRuntime({
    appId: 'output-safety-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
    ...(hook === undefined ? {} : { outputSafety: hook }),
  });
  let readState: () => Promise<unknown> = async () => undefined;
  let graphReturned = false;
  const agent: LangGraphAgent = (host) => {
    const model = host.langchain.chatModel('assistant');
    let savedConfig: LangGraphRunnableConfig = {};
    const graph = new StateGraph(state)
      .addNode('respond', async ({ input }, config) => {
        savedConfig = config;
        const message = await model.invoke(input, config);
        graphReturned = true;
        return { answer: message.text };
      })
      .addEdge(START, 'respond')
      .addEdge('respond', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
    readState = async () =>
      (
        await graph.getState({
          configurable: { thread_id: savedConfig.configurable?.['thread_id'] },
        })
      ).values;
    return graph;
  };
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/output-safety',
        version: '1.0.0',
        executor: 'langgraph-js',
        input: z.object({ input: z.string() }),
        models: { assistant: { modality: 'text' } },
      }),
      {
        principalScope: 'test-user',
        agent,
        services: {
          chatModels: { mock: new MockChatModel({ hello: { id: 'reply', text: reply } }) },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { assistant: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ input: 'hello' });
    const events = await collect(instance.events(runId));
    const values = await readState();
    const snapshot = instance.getSnapshot();
    await runtime.dispose();
    await provider.forceFlush();
    return {
      events,
      snapshot,
      diagnostics,
      values,
      graphReturned,
      spans: exporter.getFinishedSpans(),
    };
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
}

function messages(events: readonly RunEvent[]): string[] {
  return events
    .filter((event) => event.type === 'stream' && event.mode === 'messages')
    .map(
      (event) =>
        ((event as Extract<RunEvent, { type: 'stream' }>).data as [BaseMessage, unknown])[0]
          .content as string,
    );
}

test('a blocking hook withholds the triggering messages chunk and fails without publishing a reply', async () => {
  const result = await run(({ text }) => (text.includes(sentinel) ? 'block' : 'allow'));
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect(messages(result.events)).toEqual(['first ']);
  expect(result.events.some((event) => event.type === 'output')).toBe(false);
  expect(result.graphReturned).toBe(false);
  expect(result.values).toEqual({ input: 'hello' });
  expect(result.diagnostics.filter((event) => event.kind === 'output_blocked')).toEqual([
    {
      kind: 'output_blocked',
      runId: result.snapshot.run?.runId,
      instanceId: result.snapshot.instanceId,
    },
  ]);
  expect(
    JSON.stringify([result.events, result.snapshot, result.values, result.diagnostics]),
  ).not.toContain(sentinel);
  expect(serializeSpans(result.spans)).not.toContain(sentinel);
  expect(result.spans.find((span) => span.name.startsWith('chat'))?.attributes).toMatchObject({
    'galaxie.output_safety': 'blocked',
    'error.type': 'GalaxieError',
    'galaxie.step.status': 'error',
  });
  assertSpanTree(result.spans);
});

test('allowing output preserves the messages stream and final output of an unset hook', async () => {
  const checks: { text: string; final: boolean }[] = [];
  const allowed = await run(({ text, final }) => {
    checks.push({ text, final });
    return 'allow';
  });
  const unset = await run();
  expect(allowed.snapshot.run?.status).toBe('succeeded');
  expect(unset.snapshot.run?.status).toBe('succeeded');
  expect(messages(allowed.events)).toEqual(['first ', `${sentinel} `, 'third']);
  expect(normalize(allowed.events)).toEqual(normalize(unset.events));
  expect(allowed.values).toEqual({ input: 'hello', answer: reply });
  expect(allowed.values).toEqual(unset.values);
  expect(checks).toEqual([
    { text: 'first ', final: false },
    { text: `first ${sentinel} `, final: false },
    { text: reply, final: false },
    { text: reply, final: true },
  ]);
  expect(
    allowed.spans.find((span) => span.name.startsWith('chat'))?.attributes['galaxie.output_safety'],
  ).toBe('allowed');
  expect(
    unset.spans.find((span) => span.name.startsWith('chat'))?.attributes['galaxie.output_safety'],
  ).toBe('unset');
  assertSpanTree(allowed.spans);
  assertSpanTree(unset.spans);
});

test('a throwing hook fails unavailable and discards its error text everywhere', async () => {
  const result = await run(() => {
    throw new Error(sentinel);
  });
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'unavailable' } });
  expect(messages(result.events)).toEqual([]);
  expect(result.graphReturned).toBe(false);
  expect(result.values).toEqual({ input: 'hello' });
  const diagnostic = result.diagnostics.find((event) => event.kind === 'output_safety_failed');
  expect(diagnostic).toEqual({
    kind: 'output_safety_failed',
    runId: result.snapshot.run?.runId,
    instanceId: result.snapshot.instanceId,
  });
  expect(diagnostic).not.toHaveProperty('error');
  expect(
    JSON.stringify([result.events, result.snapshot, result.values, result.diagnostics]),
  ).not.toContain(sentinel);
  expect(serializeSpans(result.spans)).not.toContain(sentinel);
  expect(
    result.spans.find((span) => span.name.startsWith('chat'))?.attributes['galaxie.output_safety'],
  ).toBe('failed');
  assertSpanTree(result.spans);
});
