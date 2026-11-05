// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { rm } from 'node:fs/promises';
import { createGoAdapter } from '@galaxie/adapter-go';
import { createRuntime, type ExecutorAdapter, type RunEvent } from '@galaxie/core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  type NodeHost,
  type Reference,
  startNodeHost,
} from '../../rag-browser/test/support/adk-go-reference.node.js';
import {
  goAvailable,
  maxWasmBytes,
  missingGo,
} from '../../rag-browser/test/support/go-gate.node.js';
import { createHostCapabilities } from '../src/host/capabilities.js';
import { LEGAL_DISCLAIMER } from '../src/host/disclaimer.js';
import {
  DATA_ANALYST_PROMPT,
  EXECUTION_ANALYST_PROMPT,
  RISK_ANALYST_PROMPT,
  TRADING_ANALYST_PROMPT,
} from '../src/recipes/financial/prompts.js';
import {
  createFinancialMockModels,
  FINANCIAL_EMPTY_PROMPT,
  FINANCIAL_SAMPLE_PROMPT,
} from '../src/recipes/financial/script.js';
import { financialGoAgent, financialGoDefinition } from '../src/recipes/financial-go/definition.js';
import { runFinancial } from './support/financial.js';
import { buildFinancialGo } from './support/financial-go.node.js';

let built: Reference | undefined;
let host: NodeHost | undefined;
beforeAll(async () => {
  if (goAvailable) {
    built = await buildFinancialGo();
    host = await startNodeHost(built);
  }
}, 300000);
afterAll(async () => {
  await host?.close();
  if (built) await rm(built.directory, { recursive: true, force: true });
});

test.skipIf(!goAvailable)(
  goAvailable ? 'the financial wasm stays within the reference module size limit' : missingGo,
  () => {
    expect(built?.wasm.bytes).toBeGreaterThan(1_000_000);
    expect(built?.wasm.bytes).toBeLessThanOrEqual(maxWasmBytes);
    console.info(`financial-go wasm ${built?.wasm.bytes} bytes`);
  },
);

test.skipIf(!goAvailable).each(['normal', 'empty'] as const)(
  goAvailable ? 'Go matches the JavaScript final reply and four state outputs: %s' : missingGo,
  async (scenario) => {
    const nodeHost = host;
    if (!nodeHost) throw new Error(missingGo);
    const js = await runFinancial(scenario);
    expect(js.status).toBe('succeeded');
    const mock = createFinancialMockModels();
    const capabilities = createHostCapabilities('demo');
    const search = capabilities.bindings['market.search@1'];
    const state: Record<string, string> = {};
    const searches: { query: string }[] = [];
    const checked: string[] = [];
    const events: RunEvent[] = [];
    const trafficStart = nodeHost.traffic.length;
    const runtime = createRuntime({
      appId: 'financial-go-test',
      executors: [
        createGoAdapter({ createWorker: () => nodeHost.createWorker() }) as ExecutorAdapter<
          unknown,
          unknown
        >,
      ],
      budgets: { steps: 10, toolCalls: 2, tokens: 20000 },
      outputSafety: ({ text }) => {
        checked.push(text);
        return 'allow';
      },
    });
    try {
      const instance = await runtime.create(financialGoDefinition, {
        principalScope: 'demo',
        agent: financialGoAgent(nodeHost.wasm),
        services: {
          chatModels: mock.chatModels,
          checkpoints: {
            async request(value: unknown) {
              const request = value as { op: string; checkpoint?: { bytes: Uint8Array } };
              if (request.op === 'put' && request.checkpoint) {
                const record = JSON.parse(new TextDecoder().decode(request.checkpoint.bytes)) as {
                  events: { actions?: { stateDelta?: Record<string, string> } }[];
                };
                for (const event of record.events) Object.assign(state, event.actions?.stateDelta);
              }
              return null;
            },
          },
        },
        models: mock.routing,
        bindings: {
          'market.search@1': {
            ...search,
            async invoke(input, context) {
              searches.push(input);
              return search.invoke(input, context);
            },
          },
        },
      });
      await instance.prepare();
      const { runId } = await instance.start({
        prompt: scenario === 'empty' ? FINANCIAL_EMPTY_PROMPT : FINANCIAL_SAMPLE_PROMPT,
      });
      for await (const event of instance.events(runId)) events.push(event);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(instance.getSnapshot().run?.status).toBe('succeeded');
      expect(events.find((event) => event.type === 'output')?.output).toBe(js.output);
      expect(state).toEqual(js.state);
      expect(Object.keys(state)).toHaveLength(4);
      expect(String(js.output).endsWith(LEGAL_DISCLAIMER)).toBe(true);
      expect(searches).toEqual(js.searches);

      const streams = events.filter((event) => event.type === 'stream');
      for (const event of streams) expect(event.executor).toBe('adk-go');
      const messages = streams
        .filter((event) => event.mode === 'messages')
        .map((event) => event.data as { author: string; text: string });
      expect([...new Set(messages.map((message) => message.author))]).toEqual([
        'data_analyst_agent',
        'trading_analyst_agent',
        'execution_analyst_agent',
        'risk_analyst_agent',
      ]);
      for (const [author, key] of [
        ['data_analyst_agent', 'market_data_analysis_output'],
        ['trading_analyst_agent', 'proposed_trading_strategies_output'],
        ['execution_analyst_agent', 'execution_plan_output'],
        ['risk_analyst_agent', 'final_risk_assessment_output'],
      ] as const) {
        const chunks = messages.filter((message) => message.author === author);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.map((chunk) => chunk.text).join('')).toBe(state[key]);
        let growing = '';
        for (const chunk of chunks) {
          growing += chunk.text;
          expect(checked).toContain(growing);
        }
      }
      const requests = nodeHost.traffic
        .slice(trafficStart)
        .filter((frame) => frame.startsWith('worker>'))
        .map(
          (frame) => JSON.parse(frame.slice('worker>'.length)) as { op?: string; payload: string },
        )
        .filter((frame) => frame.op === 'model')
        .map(
          (frame) => JSON.parse(frame.payload) as { role: string; messages: { content: string }[] },
        );
      expect(requests.map((request) => request.role)).toEqual(
        js.requests.map((request) => request.role),
      );
      const prompts = [
        DATA_ANALYST_PROMPT,
        DATA_ANALYST_PROMPT,
        TRADING_ANALYST_PROMPT,
        EXECUTION_ANALYST_PROMPT,
        RISK_ANALYST_PROMPT,
      ];
      for (const [index, request] of requests.entries()) {
        let instruction = prompts[index] ?? '';
        for (const [key, value] of Object.entries(state))
          instruction = instruction.replaceAll(`{${key}?}`, value);
        expect(request.messages[0]?.content.startsWith(instruction)).toBe(true);
      }
    } finally {
      await runtime.dispose();
    }
  },
  30000,
);
