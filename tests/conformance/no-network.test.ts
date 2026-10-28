// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, defineAgentDefinition } from '@galaxie/core';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { trace } from '@opentelemetry/api';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { recordNetwork } from '../../packages/core/test/network-recorder.js';
import { CASE_NAMES, cases } from './cases/index.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import {
  createModelLatch,
  FixtureModelError,
  ScriptedChatModel,
} from './support/scripted-chat-model.js';
import { runGalaxie } from './support/transcript.js';

const definition = defineAgentDefinition({
  id: 'conformance/no-network',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({ request: z.string() }),
  models: assistantRoles,
});

test('network recording preserves runner-origin fetch and WebSocket APIs while recording other origins', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const fetchRunner = vi.fn<typeof fetch>(async () => new Response('runner module'));
  const opened: string[] = [];
  class RunnerSocket {
    constructor(url: string) {
      opened.push(url);
    }
  }
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    fetchRunner(input, init),
  );
  vi.stubGlobal('WebSocket', RunnerSocket);
  const recorder = recordNetwork('https://vitest.invalid');
  try {
    await recorder.selfTest();
    const request = new Request('https://vitest.invalid/module');
    const init = { headers: { 'x-test': 'runner' } };
    expect(await (await globalThis.fetch(request, init)).text()).toBe('runner module');
    expect(fetchRunner).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(new WebSocket('wss://vitest.invalid/channel')).toBeInstanceOf(RunnerSocket);
    expect(opened).toEqual(['wss://vitest.invalid/channel']);
    expect(recorder.calls).toEqual([]);

    await globalThis.fetch('http://vitest.invalid/module');
    new WebSocket('wss://outside.invalid/channel');
    expect(recorder.calls).toEqual(['fetch', 'WebSocket']);
    expect(fetchRunner).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
  } finally {
    recorder.restore();
    vi.stubGlobal('fetch', originalFetch);
    vi.stubGlobal('WebSocket', originalWebSocket);
  }
});

test('a real adapter success, failure and cancellation lifecycle makes no outbound request without an SDK', async () => {
  trace.disable();
  const recorder = recordNetwork(
    typeof window === 'undefined' ? undefined : window.location.origin,
  );
  const nodeRecorder =
    typeof window === 'undefined'
      ? (await import('./support/network.node.js')).recordNodeNetwork()
      : undefined;
  const latch = createModelLatch();
  let modelSignal: AbortSignal | undefined;
  const model = new ScriptedChatModel({
    success: {
      id: 'reply-success',
      text: 'done',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
    failure: { error: new FixtureModelError('canary-network-error') },
    cancel: {
      id: 'reply-cancel',
      text: 'cancelled reply',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      wait: {
        ...latch,
        wait(signal): Promise<void> {
          modelSignal = signal;
          return latch.wait(signal);
        },
      },
    },
  });
  try {
    await recorder.selfTest();
    await nodeRecorder?.selfTest();
    const runtime = createRuntime({ appId: 'conformance', executors: [createLangGraphAdapter()] });
    try {
      const instance = await runtime.create(definition, {
        principalScope: 'conformance',
        services: { chatModels: { assistant: model } },
        models: assistantRouting(),
        agent: (host) => {
          const state = Annotation.Root({
            request: Annotation<string>,
            answer: Annotation<string>,
          });
          return new StateGraph(state)
            .addNode('respond', async ({ request }, config) => ({
              answer: (
                await host.langchain
                  .chatModel('assistant')
                  .invoke([new HumanMessage({ id: `human-${request}`, content: request })], config)
              ).content,
            }))
            .addEdge(START, 'respond')
            .addEdge('respond', END)
            .compile({ checkpointer: host.langchain.checkpointer() });
        },
      });
      await instance.prepare();
      const succeeded = await instance.start({ request: 'success' });
      expect((await collect(instance.events(succeeded.runId))).at(-1)).toMatchObject({
        type: 'output',
        output: { request: 'success', answer: 'done' },
      });
      expect(instance.getSnapshot().run?.status).toBe('succeeded');

      const failed = await instance.start({ request: 'failure' });
      expect((await collect(instance.events(failed.runId))).at(-1)).toMatchObject({
        type: 'error',
        error: { code: 'executor_error', type: 'FixtureModelError' },
      });
      expect(instance.getSnapshot().run?.status).toBe('failed');

      const cancelled = await instance.start({ request: 'cancel' });
      await latch.entered;
      await instance.cancel(cancelled.runId);
      expect((await collect(instance.events(cancelled.runId))).at(-1)?.type).toBe('cancelled');
      expect(instance.getSnapshot().run?.status).toBe('cancelled');
      expect(modelSignal?.aborted).toBe(true);
      latch.release();
      const successor = await instance.start({ request: 'success' });
      expect((await collect(instance.events(successor.runId))).at(-1)).toMatchObject({
        type: 'output',
        output: { request: 'success', answer: 'done' },
      });
      expect(instance.getSnapshot().run?.status).toBe('succeeded');
      await runtime.dispose();
      expect(instance.getSnapshot().state).toBe('disposed');
      expect(recorder.calls).toEqual([]);
      expect(nodeRecorder?.calls ?? []).toEqual([]);
    } finally {
      latch.release();
      await runtime.dispose();
    }
  } finally {
    recorder.restore();
    nodeRecorder?.restore();
    trace.disable();
  }
});

test('all conformance cases including capability and step-limit make no outbound requests', async () => {
  trace.disable();
  const recorder = recordNetwork(
    typeof window === 'undefined' ? undefined : window.location.origin,
  );
  try {
    await recorder.selfTest();
    for (const name of CASE_NAMES) await runGalaxie(cases[name]);
    expect(recorder.calls).toEqual([]);
  } finally {
    recorder.restore();
    trace.disable();
  }
});
