// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import { createRuntime, defineAgentDefinition } from '@galaxie/core';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, interrupt, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { request } from './cases/interrupt-resume.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import { runGalaxie } from './support/transcript.js';

test('requestInteraction after await pauses and resumes through explicit config', async () => {
  const transcript = await runGalaxie({
    input: { value: 1 },
    script: {},
    resumes: [{ action: 'submit', payload: false }],
    factory: (langgraph, _model, checkpointer) => {
      const state = langgraph.Annotation.Root({
        value: langgraph.Annotation<number>,
        answer: langgraph.Annotation<unknown>,
      });
      return new langgraph.StateGraph(state)
        .addNode('ask', async (_state, config) => {
          await Promise.resolve();
          return { answer: requestInteraction(request, config) };
        })
        .addEdge(langgraph.START, 'ask')
        .addEdge('ask', langgraph.END)
        .compile({ checkpointer });
    },
  });
  expect(transcript.outcome).toEqual({ status: 'succeeded' });
  expect(transcript.pauses).toHaveLength(1);
  expect(transcript.final).toEqual({ value: 1, answer: { action: 'submit', payload: false } });
});

test('stock interrupt after await fails with executor_error under the shim', async () => {
  const runtime = createRuntime({ appId: 'context', executors: [createLangGraphAdapter()] });
  const definition = defineAgentDefinition({
    id: 'conformance/context',
    version: '1.0.0',
    executor: 'langgraph-js',
    input: z.unknown(),
  });
  const state = Annotation.Root({ value: Annotation<number> });
  const instance = await runtime.create(definition, {
    principalScope: 'fixture',
    agent: (host) =>
      new StateGraph(state)
        .addNode('ask', async () => {
          await Promise.resolve();
          interrupt(request);
          return {};
        })
        .addEdge(START, 'ask')
        .addEdge('ask', END)
        .compile({ checkpointer: host.langchain.checkpointer() }),
  });
  try {
    await instance.prepare();
    const { runId } = await instance.start({ value: 1 });
    expect((await collect(instance.events(runId))).at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'executor_error' },
    });
    expect(instance.getSnapshot().run?.pending).toBeUndefined();
  } finally {
    await runtime.dispose();
  }
});

test('a model called without config in the synchronous prefix emits messages', async () => {
  const script = {
    hello: {
      id: 'reply-context',
      text: 'context answer',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    },
  };
  const transcript = await runGalaxie({
    input: { value: 1 },
    script,
    factory: (langgraph, _routedModel, checkpointer) => {
      const model = new ScriptedChatModel(script);
      const state = langgraph.Annotation.Root({
        value: langgraph.Annotation<number>,
        answer: langgraph.Annotation<unknown>,
      });
      return new langgraph.StateGraph(state)
        .addNode('chat', async () => ({
          answer: (
            await model.invoke([new HumanMessage({ id: 'human-context', content: 'hello' })])
          ).content,
        }))
        .addEdge(langgraph.START, 'chat')
        .addEdge('chat', langgraph.END)
        .compile({ checkpointer });
    },
  });
  expect(transcript.outcome).toEqual({ status: 'succeeded' });
  expect(transcript.events.messages.length).toBeGreaterThan(0);
  expect(transcript.final).toEqual({ value: 1, answer: 'context answer' });
});
