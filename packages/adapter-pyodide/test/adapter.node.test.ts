// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { writeFile } from 'node:fs/promises';
import { createRuntime, type RunEvent } from '@galaxie/core';
import { expect, test, vi } from 'vitest';
import { pythonRagDefinition } from '../../../examples/rag-browser/src/agent/definition-python.js';
import { userPrompt } from '../../../examples/rag-browser/src/agent/prompt.js';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../../examples/rag-browser/test/support/python.node.js';
import { createMockLatch, MockChatModel } from '../../models/src/mock.js';
import { createPyodideAdapter } from '../src/adapter.js';
import { type BridgeMessage, parseBridge } from '../src/bridge.js';
import { lockedWheels, runtimeFiles } from '../src/runtime-files.js';

function messages(records: readonly string[]): BridgeMessage[] {
  return records.map(parseBridge);
}
async function events(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}
const passages = [
  { id: 'france', title: 'France', text: 'Paris is the capital of France.', score: 1 },
];

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'real Node Python graph uses routed models and broker scopes without exposing credentials or blocked output'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture();
    const model = new MockChatModel({
      [userPrompt('capital of France', passages)]: {
        id: 'answer',
        text: 'Paris [1].',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    });
    const factory = vi.fn(() => model);
    let block = false;
    const scope: (string | undefined)[] = [];
    const adapter = createPyodideAdapter(fixture.options);
    const runtime = createRuntime({
      appId: 'python-node-route',
      executors: [
        {
          ...adapter,
          async prepare(...args: Parameters<typeof adapter.prepare>) {
            const executor = await adapter.prepare(...args);
            return {
              ...executor,
              async *run(request) {
                const capabilities = request.capabilities;
                yield* executor.run({
                  ...request,
                  capabilities: {
                    call(name, input, options) {
                      scope.push(options?.effectScope);
                      return capabilities.call(name, input, options);
                    },
                  },
                });
              },
            };
          },
        },
      ],
      outputSafety: () => (block ? 'block' : 'allow'),
    });
    try {
      const instance = await runtime.create(pythonRagDefinition, {
        principalScope: 'fixture',
        agent: fixture.agent,
        services: { chatModels: { mock: factory } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
              credential: true,
            },
          },
          roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
          getCredential: () => 'HOST-ONLY-PYTHON-CREDENTIAL',
        },
        bindings: {
          'docs.search@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 5000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            invoke: vi.fn(async () => ({ passages })),
          },
        },
      });
      expect(fixture.counts.created).toBe(0);
      expect(fixture.requests).toEqual([]);
      await instance.prepare();
      const first = await instance.start({ question: 'capital of France', mode: 'hybrid' });
      const firstEvents = await events(instance.events(first.runId));
      expect(firstEvents.find((event) => event.type === 'output')).toMatchObject({
        output: {
          answer: 'Paris [1].',
          citations: [
            {
              marker: 1,
              passageId: 'france',
              title: 'France',
              text: 'Paris is the capital of France.',
            },
          ],
        },
      });
      expect(instance.getSnapshot().run).toMatchObject({
        status: 'succeeded',
        labels: expect.arrayContaining(['private-user']),
      });
      expect(instance.getSnapshot().routes?.['rag.answer']).toMatchObject({
        providerId: 'mock',
        destination: 'in-browser',
      });
      expect(scope[0]).toMatch(/^retrieve:/);
      expect(factory).toHaveBeenCalledWith({ credential: 'HOST-ONLY-PYTHON-CREDENTIAL' });
      expect(
        JSON.stringify([
          fixture.toWorker,
          fixture.fromWorker,
          firstEvents,
          instance.getSnapshot(),
          fixture.requests,
          fixture.workerErrors,
        ]),
      ).not.toContain('HOST-ONLY-PYTHON-CREDENTIAL');
      const checkedReplies = messages(fixture.toWorker).filter(
        (message) => message.kind === 'response' && message.op === 'model' && message.ok,
      );
      expect(checkedReplies).toHaveLength(1);
      const ready = fixture.bootEvents.find((event) => event.phase === 'ready');
      const wheelBytes =
        lockedWheels.reduce((sum, file) => sum + file.bytes, 0) +
        fixture.options.localWheels.reduce((sum, file) => sum + file.bytes, 0);
      const runtimeFileBytes = runtimeFiles.reduce((sum, file) => sum + file.bytes, 0);
      const agentSourceBytes = fixture.requests
        .filter((record) => record.url.startsWith('/python/agent/'))
        .reduce((sum, record) => sum + record.bytes, 0);
      await writeFile(
        '/tmp/galaxie-rag-python-node-metrics.json',
        JSON.stringify(
          {
            host: 'Node',
            version: process.version,
            coldStartMs: ready?.coldStartMs,
            runtimeFileBytes,
            wheelBytes,
            agentSourceBytes,
            pythonAssetBytes: runtimeFileBytes + wheelBytes + agentSourceBytes,
            requestedResponseBytes: fixture.requests.reduce((sum, record) => sum + record.bytes, 0),
          },
          null,
          2,
        ),
      );
      block = true;
      const before = fixture.toWorker.length;
      const second = await instance.start({ question: 'capital of France', mode: 'hybrid' });
      const blockedEvents = await events(instance.events(second.runId));
      expect(blockedEvents.find((event) => event.type === 'error')).toMatchObject({
        error: { code: 'denied', message: 'Policy denied the request.' },
      });
      expect(instance.getSnapshot().run?.status).toBe('failed');
      expect(fixture.toWorker.slice(before).join('\n')).not.toContain('Paris [1].');
      expect(fixture.counts.created).toBe(1);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  60000,
);

const lifecycleGraph = `
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langchain_core.messages import HumanMessage
from galaxie.capabilities import call
from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer
class State(TypedDict, total=False):
    question: str
    mode: str
    answer: str
    citations: list
def create_agent():
    async def retrieve(state, config):
        name = 'not.allowed@1' if state['question'] == 'undeclared' else 'docs.search@1'
        await call(name, {'query': state['question'], 'mode': state['mode'], 'k': 10}, config)
        return {}
    async def generate(state, config):
        if state['question'] == 'slow':
            await GalaxieChatModel(role='rag.answer').ainvoke([HumanMessage(content='delayed')], config)
        if state['question'] == 'busy':
            from js import postMessage
            postMessage('test:entered-busy-loop')
            while True:
                pass
        return {'answer': 'ready', 'citations': []}
    graph = StateGraph(State)
    graph.add_node('retrieve', retrieve)
    graph.add_node('generateAnswer', generate)
    graph.add_edge(START, 'retrieve')
    graph.add_edge('retrieve', 'generateAnswer')
    graph.add_edge('generateAnswer', END)
    return graph.compile(checkpointer=checkpointer())
`;

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'real Node Python aborts model calls, fences undeclared tools and replaces a busy interpreter'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture({
      sources: { 'lifecycle.py': lifecycleGraph },
      module: 'lifecycle',
    });
    const latch = createMockLatch();
    const model = new MockChatModel({ delayed: { id: 'delayed', text: 'late', wait: latch } });
    const runtime = createRuntime({
      appId: 'python-node-lifecycle',
      executors: [createPyodideAdapter(fixture.options)],
      outputSafety: () => 'allow',
    });
    try {
      const instance = await runtime.create(pythonRagDefinition, {
        principalScope: 'fixture',
        agent: fixture.agent,
        services: { chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
        bindings: {
          'docs.search@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 5000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            invoke: async () => ({ passages: [] }),
          },
        },
      });
      await instance.prepare();
      const denied = await instance.start({ question: 'undeclared', mode: 'hybrid' });
      expect(
        (await events(instance.events(denied.runId))).find((event) => event.type === 'error'),
      ).toMatchObject({ error: { code: 'denied' } });
      const slow = await instance.start({ question: 'slow', mode: 'hybrid' });
      const slowEvents = events(instance.events(slow.runId));
      await latch.entered;
      await instance.cancel(slow.runId);
      expect((await slowEvents).some((event) => event.type === 'cancelled')).toBe(true);
      await vi.waitFor(() =>
        expect(
          messages(fixture.fromWorker).some(
            (message) => message.kind === 'response' && message.op === 'abort' && message.ok,
          ),
        ).toBe(true),
      );
      expect(fixture.counts.terminated).toBe(1);
      const busy = await instance.start({ question: 'busy', mode: 'hybrid' });
      const busyEvents = events(instance.events(busy.runId));
      let busyCall: BridgeMessage | undefined;
      await vi.waitFor(
        () => {
          busyCall = messages(fixture.fromWorker).findLast(
            (message) =>
              message.kind === 'request' &&
              message.op === 'capability' &&
              (message.payload as { input: { query: string } }).input.query === 'busy',
          );
          expect(busyCall).toBeDefined();
          expect(
            messages(fixture.toWorker).some(
              (message) => message.kind === 'response' && message.id === busyCall?.id && message.ok,
            ),
          ).toBe(true);
        },
        { timeout: 15000 },
      );
      await fixture.enteredBusyLoop;
      const before = fixture.fromWorker.length;
      await instance.cancel(busy.runId);
      expect((await busyEvents).some((event) => event.type === 'cancelled')).toBe(true);
      await vi.waitFor(() => expect(fixture.counts.terminated).toBe(2), { timeout: 2000 });
      expect(
        messages(fixture.fromWorker.slice(before)).some(
          (message) => message.kind === 'response' && message.op === 'abort',
        ),
      ).toBe(false);
      const next = await instance.start({ question: 'fast', mode: 'hybrid' });
      expect(
        (await events(instance.events(next.runId))).find((event) => event.type === 'output'),
      ).toMatchObject({ output: { answer: 'ready', citations: [] } });
      expect(fixture.counts.created).toBe(3);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      latch.release();
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  90000,
);
