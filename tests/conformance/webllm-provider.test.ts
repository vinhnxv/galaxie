// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, type DiagnosticEvent, defineAgentDefinition } from '@galaxie/core';
import { WebLLMChatModel } from '@galaxie/models/webllm';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { RunBudget } from '../../packages/core/src/budgets.js';
import { collect } from '../../packages/core/test/fake-executor.js';
import { recordNetwork } from '../../packages/core/test/network-recorder.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';
import { createWebLLMEngine } from '../../packages/models/src/webllm/engine.js';
import {
  createFakeWebLLM,
  type FakeWebLLMOptions,
  FakeWebLLMStream,
} from '../../packages/models/test/support/fake-webllm.js';

const state = Annotation.Root({ text: Annotation<string>, answer: Annotation<string> });
const definition = defineAgentDefinition({
  id: 'conformance/webllm',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({ text: z.string() }),
  models: { assistant: { modality: 'text' } },
});

test.each(['success', 'cancel', 'worker-failed'] as const)(
  'WebLLM runtime %s uses no network and settles the model budget',
  async (mode) => {
    const network = recordNetwork(
      typeof window === 'undefined' ? undefined : window.location.origin,
    );
    const nodeNetwork =
      typeof window === 'undefined'
        ? (await import('./support/network.node.js')).recordNodeNetwork()
        : undefined;
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const options: FakeWebLLMOptions =
      mode === 'cancel'
        ? {
            create: async () =>
              new FakeWebLLMStream(undefined, {
                beforeNext: async (index) => {
                  if (index === 1) {
                    entered.resolve();
                    await blocked.promise;
                  }
                },
              }),
          }
        : {};
    const fake = createFakeWebLLM(options);
    const handle = await createWebLLMEngine(
      { worker: fake.worker },
      { gpu: fake.gpu, loadModule: async () => fake.module },
    );
    const charges: number[] = [];
    const originalReserve = RunBudget.prototype.reserveModel;
    const reserve = vi.spyOn(RunBudget.prototype, 'reserveModel').mockImplementation(function (
      this: RunBudget,
      tokens,
      cost,
    ) {
      const reservation = originalReserve.call(this, tokens, cost);
      // A cancelled terminal run retains its reservation; core ignores later settlements.
      const index = charges.push(tokens) - 1;
      const settle = reservation.settle;
      const release = reservation.release;
      reservation.release = (): void => {
        charges[index] = 0;
        release();
      };
      reservation.settle = (chargedTokens, chargedCost): void => {
        charges[index] = chargedTokens;
        settle(chargedTokens, chargedCost);
      };
      return reservation;
    });
    const { exporter, provider } = createSpanRecorder();
    const diagnostics: DiagnosticEvent[] = [];
    const received: string[] = [];
    const runtime = createRuntime({
      appId: 'webllm-test',
      executors: [createLangGraphAdapter()],
      tracerProvider: provider,
      diagnostics: (event) => diagnostics.push(event),
      budgets: { tokens: 117 },
    });
    try {
      await network.selfTest();
      await nodeNetwork?.selfTest();
      if (mode === 'worker-failed') fake.worker.fail();
      const instance = await runtime.create(definition, {
        principalScope: 'webllm-test',
        services: { chatModels: { local: new WebLLMChatModel(handle) } },
        models: {
          providers: {
            local: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming', 'cancellation'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 100 } },
        },
        agent: (host) =>
          new StateGraph(state)
            .addNode('respond', async ({ text }, config) => {
              let answer = '';
              // The second reservation succeeds only if the first call charged actual usage (17).
              for (let call = 0; call < (mode === 'success' ? 2 : 1); call++) {
                for await (const chunk of await host.langchain
                  .chatModel('assistant')
                  .stream([new HumanMessage(text)], config)) {
                  if (typeof chunk.content === 'string' && chunk.content) {
                    received.push(chunk.content);
                    answer += chunk.content;
                  }
                }
              }
              return { answer };
            })
            .addEdge(START, 'respond')
            .addEdge('respond', END)
            .compile(),
      });
      await instance.prepare();
      const { runId } = await instance.start({ text: 'private prompt canary' });
      if (mode === 'cancel') {
        await entered.promise;
        await instance.cancel(runId);
      }
      const events = await collect(instance.events(runId));
      await runtime.dispose();
      await provider.forceFlush();
      expect(instance.getSnapshot().routes?.['assistant']).toEqual({
        providerId: 'local',
        destination: 'in-browser',
      });
      if (mode === 'success') {
        expect(events.at(-1)).toMatchObject({
          type: 'output',
          output: { answer: 'hello worldhello world' },
        });
        expect(received).toEqual(['hello ', 'world', 'hello ', 'world']);
        expect(charges).toEqual([17, 17]);
        expect(instance.getSnapshot().run?.status).toBe('succeeded');
      } else if (mode === 'cancel') {
        expect(events.at(-1)?.type).toBe('cancelled');
        expect(instance.getSnapshot().run?.status).toBe('cancelled');
        expect(charges).toEqual([100]);
        expect(fake.engine.interrupts).toBe(1);
      } else {
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
        expect(instance.getSnapshot().run?.status).toBe('failed');
        expect(charges).toEqual([100]);
        expect(fake.engine.requests).toEqual([]);
        expect(JSON.stringify({ diagnostics, snapshot: instance.getSnapshot() })).not.toContain(
          'private prompt canary',
        );
      }
      expect(serializeSpans(exporter.getFinishedSpans())).not.toContain('private prompt canary');
      fake.engine.assertClosed();
      expect(network.calls).toEqual([]);
      expect(nodeNetwork?.calls ?? []).toEqual([]);
    } finally {
      blocked.resolve();
      await runtime.dispose();
      await handle.dispose();
      await provider.shutdown();
      reserve.mockRestore();
      network.restore();
      nodeNetwork?.restore();
    }
  },
);
