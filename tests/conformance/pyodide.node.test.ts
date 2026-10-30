// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import {
  createRuntime,
  defineAgentDefinition,
  type RunEvent,
  type RunRequest,
} from '@galaxie/core';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { BRIDGE_VERSION, parseBridge } from '../../packages/adapter-pyodide/src/bridge.js';
import { createMockLatch, MockChatModel } from '../../packages/models/src/mock.js';
import { pythonCaseSources } from './support/python-cases.node.js';
import { executePythonCase, pythonStageACases } from './support/python-stage-a.js';

test.skipIf(!pythonWheelsAvailable).each(pythonStageACases)(
  pythonWheelsAvailable
    ? 'Node Pyodide matches native Python interrupts and counters: %s'
    : missingPythonWheels,
  async (name) => {
    const fixture = await createPythonFixture({
      sources: await pythonCaseSources(name),
      module: 'selected',
    });
    try {
      const golden = JSON.parse(
        await readFile(new URL(`./golden-python/${name}.json`, import.meta.url), 'utf8'),
      );
      const resumes =
        name === 'interrupt-sequence'
          ? [
              { action: 'submit', payload: 'first' },
              { action: 'submit', payload: false },
            ]
          : [{ action: 'submit', payload: { answer: 'yes' } }];
      const actual = await executePythonCase(
        fixture.options,
        fixture.agent,
        name,
        { value: 1 },
        resumes,
      );
      expect(actual.pauses).toEqual(
        golden.pauses.map(({ interrupts }: { interrupts: unknown }) => ({ interrupts })),
      );
      expect(actual.final).toEqual(golden.final);
      expect(actual.final).toEqual(golden.state.values);
      expect(actual.emptyPending).toBe(true);
      expect(actual.stablePending).toBe(true);
      expect(actual.repeated).toEqual([
        {
          type: 'error',
          error: { code: 'unsupported', message: 'This operation is unsupported.' },
        },
      ]);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  60000,
);

test.skipIf(!pythonWheelsAvailable)(
  'real Python interactions publish waiting_input and accept one core dispatch',
  async () => {
    const fixture = await createPythonFixture({
      sources: await pythonCaseSources('interrupt-resume'),
      module: 'selected',
    });
    const runtime = createRuntime({
      appId: 'python-core-interaction',
      executors: [createPyodideAdapter(fixture.options)],
    });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'conformance/python',
          version: '1.0.0',
          executor: 'langgraph-python',
          input: z.unknown(),
        }),
        {
          principalScope: 'fixture',
          agent: fixture.agent,
        },
      );
      await instance.prepare();
      const { runId } = await instance.start({ value: 1 });
      const initial: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        initial.push(event);
        if (event.type === 'interaction') break;
      }
      expect(initial.find((event) => event.type === 'interaction')).toBeDefined();
      expect(instance.getSnapshot().run?.status).toBe('waiting_input');
      const pending = instance.getSnapshot().run?.pending;
      if (!pending) throw new Error('Missing pending Python interaction.');
      const event = {
        instanceId: instance.instanceId,
        runId,
        ...pending,
        action: 'submit',
        payload: { answer: 'yes' },
      };
      expect(await instance.dispatch(event)).toEqual({
        status: 'accepted',
        interactionId: pending.interactionId,
      });
      const resumed: RunEvent[] = [];
      for await (const event of instance.events(runId)) resumed.push(event);
      expect(resumed.find((event) => event.type === 'output')).toMatchObject({
        output: { value: 1, answer: { answer: 'yes' }, counts: { prepare: 1, ask: 2 } },
      });
      expect(instance.getSnapshot().run?.status).toBe('succeeded');
      expect(await instance.dispatch(event)).toMatchObject({
        status: 'rejected',
        error: { code: 'duplicate' },
      });
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  60000,
);

test.skipIf(!pythonWheelsAvailable)(
  'real Worker rejects v1, unknown operations and unexpected notifications',
  async () => {
    const fixture = await createPythonFixture();
    try {
      for (const message of [
        {
          v: 'galaxie.bridge/v1',
          kind: 'request',
          id: 'one',
          op: 'pending',
          payload: { threadId: 's' },
        },
        { v: BRIDGE_VERSION, kind: 'request', id: 'one', op: 'unknown', payload: {} },
        {
          v: BRIDGE_VERSION,
          kind: 'notify',
          id: 'one',
          op: 'stream',
          payload: [[], 'updates', {}],
        },
      ]) {
        const worker = fixture.options.createWorker();
        try {
          const result = new Promise<unknown>((resolve) =>
            worker.addEventListener('message', (event) => resolve(parseBridge(event.data))),
          );
          worker.postMessage(JSON.stringify(message));
          expect(await result).toMatchObject({
            kind: 'response',
            ok: false,
            error: { code: 'invalid' },
          });
        } finally {
          worker.terminate();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  },
  30000,
);

test.skipIf(!pythonWheelsAvailable)(
  'cancelling a resumed Python model call settles cancelled and loses in-memory state',
  async () => {
    const fixture = await createPythonFixture({
      sources: {
        'selected.py': `
from langgraph.graph import StateGraph, START, END
from galaxie.langgraph import checkpointer, request_interaction
from galaxie.langchain import GalaxieChatModel
def create_agent():
    def ask(state, config):
        return request_interaction({'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'conformance.Question/v1', 'props': {}}, config)
    async def chat(state, config):
        await GalaxieChatModel(role='answer').ainvoke('delayed', config)
        return {}
    return StateGraph(dict).add_node('ask', ask).add_node('chat', chat).add_edge(START, 'ask').add_edge('ask', 'chat').add_edge('chat', END).compile(checkpointer=checkpointer())
`,
      },
      module: 'selected',
    });
    const latch = createMockLatch();
    const runtime = createRuntime({
      appId: 'python-resume-abort',
      executors: [createPyodideAdapter(fixture.options)],
      outputSafety: () => 'allow',
    });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'conformance/python-abort',
          version: '1.0.0',
          executor: 'langgraph-python',
          input: z.unknown(),
          models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        }),
        {
          principalScope: 'fixture',
          agent: fixture.agent,
          services: {
            chatModels: {
              mock: new MockChatModel({ delayed: { id: 'delayed', text: 'late', wait: latch } }),
            },
          },
          models: {
            providers: {
              mock: {
                destination: 'in-browser',
                modality: 'text',
                languages: ['en'],
                features: [],
                pricing: { inputPerToken: 0, outputPerToken: 0 },
              },
            },
            roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
          },
        },
      );
      await instance.prepare();
      const { runId } = await instance.start({});
      for await (const event of instance.events(runId)) {
        if (event.type === 'interaction') break;
        if (event.type === 'error') throw new Error(event.error.message);
      }
      const pending = instance.getSnapshot().run?.pending;
      if (!pending) throw new Error('Missing pending Python interaction.');
      expect(
        await instance.dispatch({
          instanceId: instance.instanceId,
          runId,
          ...pending,
          action: 'submit',
          payload: false,
        }),
      ).toMatchObject({ status: 'accepted' });
      const events = (async () => {
        const result: RunEvent[] = [];
        for await (const event of instance.events(runId)) result.push(event);
        return result;
      })();
      await latch.entered;
      await instance.cancel(runId);
      expect((await events).some((event) => event.type === 'cancelled')).toBe(true);
      expect(instance.getSnapshot().run?.status).toBe('cancelled');
      await expect.poll(() => fixture.counts.terminated, { timeout: 2000 }).toBe(1);
      expect(fixture.toWorker.join('\n')).not.toContain('late');
    } finally {
      latch.release();
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  60000,
);

test.skipIf(!pythonWheelsAvailable)(
  'the Python astream loop preserves the finite step budget',
  async () => {
    const fixture = await createPythonFixture({
      sources: await pythonCaseSources('step-limit'),
      module: 'selected',
    });
    const executor = await createPyodideAdapter(fixture.options).prepare(
      fixture.agent,
      { chatModels: {} },
      { signal: new AbortController().signal },
    );
    try {
      const events = [];
      for await (const event of executor.run({
        runId: 'steps' as never,
        sessionId: 'steps' as never,
        command: { type: 'start', input: { value: 0 } },
        limits: { steps: 3 },
        signal: new AbortController().signal,
        trace: {} as RunRequest['trace'],
        models: {
          async begin() {
            throw new Error('Unexpected model call.');
          },
        },
        capabilities: {
          async call() {
            throw new Error('Unexpected capability call.');
          },
        },
      }))
        events.push(event);
      expect(events).toEqual([
        {
          type: 'error',
          error: { code: 'budget_exceeded', message: 'The budget limit was reached.' },
        },
      ]);
      expect(await executor.pending('steps' as never)).toBeUndefined();
    } finally {
      await executor.dispose();
      await fixture.cleanup();
    }
  },
  60000,
);

test.skipIf(!pythonWheelsAvailable).each(['invalid', 'parallel', 'oversized', 'static'] as const)(
  'real Python rejects %s interrupt states with fixed errors',
  async (kind) => {
    const request =
      kind === 'invalid'
        ? "{'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'invalid', 'props': {}}"
        : `{'surfaceId': 'main', 'viewRevision': 'r1', 'component': 'conformance.Question/v1', 'props': ${kind === 'oversized' ? "{'text': 'é' * 524289}" : '{}'}}`;
    const parallel =
      kind === 'parallel'
        ? ".add_node('other', ask).add_edge(START, 'other').add_edge('other', END)"
        : '';
    const staticConfig = kind === 'static' ? ", interrupt_before=['ask']" : '';
    const fixture = await createPythonFixture({
      sources: {
        'selected.py': `from langgraph.graph import StateGraph, START, END\nfrom langgraph.types import interrupt\nfrom galaxie.langgraph import checkpointer\ndef create_agent():\n    def ask(state):\n        interrupt(${request})\n        return {}\n    return StateGraph(dict).add_node('ask', ask).add_edge(START, 'ask').add_edge('ask', END)${parallel}.compile(checkpointer=checkpointer()${staticConfig})\n`,
      },
      module: 'selected',
    });
    const executor = await createPyodideAdapter(fixture.options).prepare(
      fixture.agent,
      { chatModels: {} },
      { signal: new AbortController().signal },
    );
    try {
      const events = [];
      for await (const event of executor.run({
        runId: 'pending' as never,
        sessionId: 'pending' as never,
        command: { type: 'start', input: {} },
        limits: { steps: 5 },
        signal: new AbortController().signal,
        trace: {} as RunRequest['trace'],
        models: {
          async begin() {
            throw new Error('Unexpected model call.');
          },
        },
        capabilities: {
          async call() {
            throw new Error('Unexpected capability call.');
          },
        },
      }))
        events.push(event);
      const code = kind === 'invalid' ? 'invalid' : 'unsupported';
      expect(events).toEqual([
        {
          type: 'error',
          error: {
            code,
            message:
              code === 'invalid' ? 'The request is invalid.' : 'This operation is unsupported.',
          },
        },
      ]);
      if (kind === 'static') expect(await executor.pending('pending' as never)).toBeUndefined();
    } finally {
      await executor.dispose();
      await fixture.cleanup();
    }
  },
  60000,
);

test.skipIf(!pythonWheelsAvailable)(
  'the Worker refuses an agent that installs its own checkpointer',
  async () => {
    const fixture = await createPythonFixture({
      sources: {
        'selected.py':
          'from langgraph.graph import StateGraph, START, END\nfrom langgraph.checkpoint.memory import InMemorySaver\ndef create_agent():\n    return StateGraph(dict).add_node("end", lambda state: state).add_edge(START, "end").add_edge("end", END).compile(checkpointer=InMemorySaver())\n',
      },
      module: 'selected',
    });
    try {
      await expect(
        createPyodideAdapter(fixture.options).prepare(
          fixture.agent,
          { chatModels: {} },
          { signal: new AbortController().signal },
        ),
      ).rejects.toMatchObject({ code: 'unsupported', message: 'This operation is unsupported.' });
    } finally {
      await fixture.cleanup();
    }
  },
  30000,
);
