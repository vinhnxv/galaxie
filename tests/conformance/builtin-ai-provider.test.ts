// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, type DiagnosticEvent, defineAgentDefinition } from '@galaxie/core';
import { BuiltInAIChatModel } from '@galaxie/models/builtin-ai';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { RunBudget } from '../../packages/core/src/budgets.js';
import { collect } from '../../packages/core/test/fake-executor.js';
import { recordNetwork } from '../../packages/core/test/network-recorder.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';
import {
  FakeLanguageModel,
  installLanguageModel,
} from '../../packages/models/test/support/fake-language-model.js';

const state = Annotation.Root({ answer: Annotation<string> });
const definition = defineAgentDefinition({
  id: 'conformance/builtin-ai',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.object({}),
  models: { assistant: { modality: 'text', languages: ['en'] } },
});

test.each(['success', 'cancel', 'downloadable', 'browser-error'] as const)(
  'Built-in AI runtime %s uses no network and charges the reservation',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const fake = new FakeLanguageModel({
      availability: async () => (mode === 'downloadable' ? 'downloadable' : 'available'),
      prompt: () => {
        if (mode === 'browser-error')
          throw new DOMException('private browser error canary', 'NetworkError');
      },
      beforeNext: async (index) => {
        if (mode === 'cancel' && index === 1) {
          entered.resolve();
          await blocked.promise;
        }
      },
    });
    const restore = installLanguageModel(fake);
    const network = recordNetwork(
      typeof window === 'undefined' ? undefined : window.location.origin,
    );
    const nodeNetwork =
      typeof window === 'undefined'
        ? (await import('./support/network.node.js')).recordNodeNetwork()
        : undefined;
    const charges: number[] = [];
    const originalReserve = RunBudget.prototype.reserveModel;
    const reserve = vi.spyOn(RunBudget.prototype, 'reserveModel').mockImplementation(function (
      this: RunBudget,
      tokens,
      cost,
    ) {
      const reservation = originalReserve.call(this, tokens, cost);
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
      appId: 'builtin-ai-test',
      executors: [createLangGraphAdapter()],
      tracerProvider: provider,
      diagnostics: (event) => diagnostics.push(event),
      budgets: { tokens: 200 },
    });
    try {
      await network.selfTest();
      await nodeNetwork?.selfTest();
      const instance = await runtime.create(definition, {
        principalScope: 'builtin-ai-test',
        services: {
          chatModels: {
            builtin: new BuiltInAIChatModel({ inputLanguages: ['en'], outputLanguages: ['en'] }),
          },
        },
        models: {
          providers: {
            builtin: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['streaming', 'cancellation'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { assistant: { providers: ['builtin'], allow: ['in-browser'], maxTokens: 100 } },
        },
        agent: (host) =>
          new StateGraph(state)
            .addNode('respond', async (_state, config) => {
              let answer = '';
              for (let call = 0; call < (mode === 'success' ? 2 : 1); call++) {
                for await (const chunk of await host.langchain
                  .chatModel('assistant')
                  .stream([new HumanMessage('private prompt canary')], config)) {
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
      const { runId } = await instance.start({});
      if (mode === 'cancel') {
        await entered.promise;
        await instance.cancel(runId);
      }
      const events = await collect(instance.events(runId));
      await runtime.dispose();
      await provider.forceFlush();
      expect(instance.getSnapshot().routes?.['assistant']).toEqual({
        providerId: 'builtin',
        destination: 'in-browser',
      });
      if (mode === 'success') {
        expect(events.at(-1)).toMatchObject({
          type: 'output',
          output: { answer: 'hello worldhello world' },
        });
        expect(received).toEqual(['hello ', 'world', 'hello ', 'world']);
        expect(charges).toEqual([100, 100]);
        expect(instance.getSnapshot().run?.status).toBe('succeeded');
        expect(fake.sessions.map((session) => session.destroys)).toEqual([1, 1]);
      } else if (mode === 'cancel') {
        expect(events.at(-1)?.type).toBe('cancelled');
        expect(instance.getSnapshot().run?.status).toBe('cancelled');
        expect(charges).toEqual([100]);
        expect(fake.sessions[0]?.destroys).toBe(1);
      } else {
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
        expect(instance.getSnapshot().run?.status).toBe('failed');
        expect(charges).toEqual([100]);
        expect(received).toEqual([]);
        if (mode === 'downloadable') expect(fake.creates).toEqual([]);
        else expect(fake.sessions[0]?.destroys).toBe(1);
      }
      const records = JSON.stringify({
        diagnostics,
        events,
        snapshot: instance.getSnapshot(),
        spans: serializeSpans(exporter.getFinishedSpans()),
      });
      expect(records).not.toContain('private prompt canary');
      expect(records).not.toContain('private browser error canary');
      expect(network.calls).toEqual([]);
      expect(nodeNetwork?.calls ?? []).toEqual([]);
    } finally {
      blocked.resolve();
      await runtime.dispose();
      await provider.shutdown();
      reserve.mockRestore();
      network.restore();
      nodeNetwork?.restore();
      restore();
    }
  },
);
