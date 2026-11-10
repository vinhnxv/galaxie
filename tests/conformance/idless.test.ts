// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  createRuntime,
  defineAgentDefinition,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import * as web from '@langchain/langgraph/web';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { serializeSpans } from '../../packages/core/test/span-tree.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { answer, ask, IDLESS_CASE_NAMES, idlessCases, question } from './cases/idless.js';
import { IDLESS_SHAPES, shapeGraph } from './cases/idless-shapes.js';
import sequence from './golden/idless-sequence.json' with { type: 'json' };
import shapes from './golden/idless-shapes.json' with { type: 'json' };
import submit from './golden/idless-submit.json' with { type: 'json' };
import { diff } from './support/diff.js';
import { normalize } from './support/normalize.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import { runGalaxie } from './support/transcript.js';

const goldens = { 'idless-submit': submit, 'idless-sequence': sequence };
const definition = defineAgentDefinition({
  id: 'conformance/idless',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.unknown(),
});

test.each(IDLESS_CASE_NAMES)('%s matches native with zero differences', async (name) => {
  expect(diff(goldens[name], normalize(await runGalaxie(idlessCases[name])))).toEqual([]);
});

test.each(IDLESS_CASE_NAMES)('%s restores in a new runtime', async (name) => {
  const saver = new web.MemorySaver();
  const paused = await runGalaxie(idlessCases[name], () => saver, true);
  const first = await saver.list({}).next();
  const sessionId = first.value?.config.configurable?.['thread_id'] as SessionId;
  const restored = await runGalaxie(idlessCases[name], () => saver, false, sessionId);
  expect(restored.outcome).toEqual({ status: 'succeeded' });
  expect(restored.pauses?.[0]).toEqual(paused.pauses?.[0]);
  expect(restored.state.next).toEqual([]);
  expect(restored.final).toMatchObject({ answer, applications: name === 'idless-submit' ? 1 : 2 });
  await expect(runGalaxie(idlessCases[name], () => saver, false, sessionId)).rejects.toThrow(
    'The conformance session has no pending interaction.',
  );
});

test.each(IDLESS_SHAPES)(
  '%s matches the recorded publication/refusal and side effects',
  async (shape) => {
    const saver = new web.MemorySaver();
    const { graph, counts } = shapeGraph(web, saver, shape, { request: requestInteraction });
    const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
    try {
      const instance = await runtime.create(definition, {
        principalScope: 'tests',
        agent: () => graph,
      });
      await instance.prepare();
      const { runId } = await instance.start({});
      let published = 0;
      let lastSequence = -1;
      for (let segment = 0; segment < 2; segment++) {
        let paused = false;
        for await (const event of instance.events(runId)) {
          if (event.sequence <= lastSequence) continue;
          lastSequence = event.sequence;
          if (event.type === 'interaction') {
            published++;
            paused = true;
            break;
          }
        }
        if (!paused) break;
        const pending = instance.getSnapshot().run?.pending;
        if (pending === undefined) throw new Error('Expected a committed pause.');
        expect(pending.interactionId).toMatch(/^idless:[0-9a-f-]{36}:0$/);
        expect(
          await instance.dispatch({
            instanceId: instance.instanceId,
            runId,
            ...pending,
            ...answer,
          }),
        ).toMatchObject({ status: 'accepted' });
      }
      await runtime.dispose();
      const run = instance.getSnapshot().run;
      const code = run?.error?.code ?? run?.status;
      expect({ code, published }).toEqual(shapes[shape].galaxie);
      expect(run?.pending).toBeUndefined();
      if (code === 'unsupported') expect(run?.error).toMatchObject(toErrorInfo('unsupported'));
      if (shape === 'supported' || shape.startsWith('bodyChild')) {
        expect(counts).toEqual(shapes[shape].native.afterCounts);
        const state = await graph.getState({ configurable: { thread_id: instance.sessionId } });
        expect(state.values).toEqual({ answers: [answer], applications: 1 });
      } else expect(counts.effects).toBe(0);
    } finally {
      await runtime.dispose();
    }
  },
);

test('checkpoint identity survives ten reads and a saver reopened with reversed writes; core validates before resume', async () => {
  const saver = new web.MemorySaver();
  const fixture = idlessCases['idless-sequence'];
  const make = async (checkpointer: web.MemorySaver, sessionId?: SessionId) => {
    const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
    const instance = await runtime.create(definition, {
      principalScope: 'tests',
      ...(sessionId === undefined ? {} : { sessionId }),
      ui: {
        components: {
          'conformance.Question/v1': {
            actions: { submit: { payload: z.object({ answer: z.string() }) } },
          },
        },
        surfaces: ['main'],
      },
      agent: () =>
        fixture.factory(web, new ScriptedChatModel({}), checkpointer, undefined, {
          request: requestInteraction,
        }),
    });
    await instance.prepare();
    return { runtime, instance };
  };
  const first = await make(saver);
  let second: Awaited<ReturnType<typeof make>> | undefined;
  try {
    const { runId } = await first.instance.start(fixture.input);
    for await (const event of first.instance.events(runId)) if (event.type === 'interaction') break;
    const original = first.instance.getSnapshot().run?.pending;
    const graph = fixture.factory(web, new ScriptedChatModel({}), saver, undefined, {
      request: requestInteraction,
    });
    const executor = await createLangGraphAdapter().prepare(
      () => graph,
      { chatModels: {} },
      { signal: new AbortController().signal },
    );
    for (let i = 0; i < 10; i++)
      expect(await executor.pending(first.instance.sessionId)).toEqual(original);
    await first.runtime.dispose();
    const reopened = new web.MemorySaver();
    reopened.storage = structuredClone(saver.storage);
    reopened.writes = structuredClone(saver.writes);
    const tuple = reopened.getTuple.bind(reopened);
    reopened.getTuple = async (config) => {
      const result = await tuple(config);
      return result === undefined
        ? undefined
        : { ...result, pendingWrites: (result.pendingWrites ?? []).toReversed() };
    };
    second = await make(reopened, first.instance.sessionId);
    const restored = await second.instance.restore();
    if (restored === undefined || original === undefined)
      throw new Error('Expected restored pause.');
    expect(second.instance.getSnapshot().run?.pending).toEqual(original);
    const instance = second.instance;
    const transform = vi.spyOn(reopened, 'putWrites');
    const event = {
      instanceId: instance.instanceId,
      runId: restored.runId,
      ...original,
      ...answer,
    };
    for (const interactionId of [
      'idless:forged:0',
      original.interactionId.replace(/:0$/, ':1'),
      '0123456789abcdef',
    ]) {
      expect(
        await instance.dispatch({
          ...event,
          interactionId: interactionId as typeof original.interactionId,
        }),
      ).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
    }
    for (const invalid of [{ action: 'missing' }, { payload: { answer: 7 } }]) {
      expect(await instance.dispatch({ ...event, ...invalid })).toMatchObject({
        status: 'rejected',
        error: { code: 'invalid' },
      });
    }
    expect(transform).not.toHaveBeenCalled();
    expect(instance.getSnapshot().run?.pending).toEqual(original);
    expect(await instance.dispatch(event)).toMatchObject({ status: 'accepted' });
    for await (const next of instance.events(restored.runId))
      if (next.type === 'interaction' && next.interaction.interactionId !== original.interactionId)
        break;
    const next = instance.getSnapshot().run?.pending;
    expect(next?.interactionId).not.toBe(original.interactionId);
    expect(await instance.dispatch(event)).toMatchObject({
      status: 'rejected',
      error: { code: expect.stringMatching(/stale|duplicate/) },
    });
    if (next === undefined) throw new Error('Expected second pause.');
    expect(
      await instance.dispatch({ ...event, ...next, payload: { answer: 'second' } }),
    ).toMatchObject({ status: 'accepted' });
    for await (const _result of instance.events(restored.runId)) {
      /* Drain completion. */
    }
    expect(instance.getSnapshot().run?.status).toBe('succeeded');
    expect(await instance.dispatch(event)).toMatchObject({
      status: 'rejected',
      error: { code: expect.stringMatching(/stale|duplicate/) },
    });
  } finally {
    await first.runtime.dispose();
    await second?.runtime.dispose();
  }
});

test.each(['nodeInterruptRequest', 'rawGraphInterrupt', 'twoInOneNode'] as const)(
  '%s retains the accepted inbox entry after failure and pins restore behavior',
  async (shape) => {
    const saver = new web.MemorySaver();
    const store = new MemoryRecoveryStore();
    const make = async (sessionId?: SessionId) => {
      const { graph, counts } = shapeGraph(web, saver, shape, { request: requestInteraction });
      const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
      const instance = await runtime.create(definition, {
        principalScope: 'tests',
        recovery: store,
        agent: () => graph,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      await instance.prepare();
      return { runtime, instance, graph, counts };
    };
    const first = await make();
    let restored: Awaited<ReturnType<typeof make>> | undefined;
    try {
      const { runId } = await first.instance.start({});
      for await (const event of first.instance.events(runId))
        if (event.type === 'interaction') break;
      const pending = first.instance.getSnapshot().run?.pending;
      if (pending === undefined) throw new Error('Expected one indistinguishable pause.');
      await first.instance.dispatch({
        instanceId: first.instance.instanceId,
        runId,
        ...pending,
        ...answer,
      });
      for await (const _event of first.instance.events(runId)) {
        /* Wait for refusal. */
      }
      expect(first.instance.getSnapshot().run?.error).toMatchObject(toErrorInfo('unsupported'));
      expect(first.instance.getSnapshot().run?.pending).toBeUndefined();
      await first.runtime.dispose();
      expect(first.counts.gate).toBe(2);
      expect(first.counts.effects).toBe(0);
      expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('accepted');
      restored = await make(first.instance.sessionId);
      if (shape === 'twoInOneNode') {
        await expect(restored.instance.restore()).rejects.toMatchObject({ code: 'executor_error' });
        expect(restored.counts.gate).toBe(0);
      } else {
        const run = await restored.instance.restore();
        if (run === undefined) throw new Error('Expected the same unresolved pause.');
        for await (const _event of restored.instance.events(run.runId)) {
          /* Wait for repeated refusal. */
        }
        expect(restored.instance.getSnapshot().run?.error).toMatchObject(
          toErrorInfo('unsupported'),
        );
        expect(restored.counts.gate).toBe(1);
      }
      expect((await store.submissions(first.instance.sessionId))[0]?.status).toBe('accepted');
    } finally {
      await first.runtime.dispose();
      await restored?.runtime.dispose();
    }
  },
);

test('an unfinished fan-out sibling cannot consume a bare answer after abort', async () => {
  const saver = new web.MemorySaver();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const state = web.Annotation.Root({ answer: web.Annotation<unknown> });
  const graph = new web.StateGraph(state)
    .addNode('fast', async (_, config) => ({
      answer: await ask({ request: requestInteraction }, config),
    }))
    .addNode('slow', async () => {
      entered.resolve();
      await held.promise;
      throw new Error('The simulated sibling was interrupted.');
    })
    .addEdge(web.START, 'fast')
    .addEdge(web.START, 'slow')
    .addEdge('fast', web.END)
    .addEdge('slow', web.END)
    .compile({ checkpointer: saver });
  const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'tests',
      agent: () => graph,
    });
    await instance.prepare();
    await instance.start({});
    await entered.promise;
    await vi.waitFor(async () => {
      const tuple = await saver.getTuple({ configurable: { thread_id: instance.sessionId } });
      expect(tuple?.pendingWrites?.some(([, channel]) => channel === '__interrupt__')).toBe(true);
    });
    const disposal = runtime.dispose();
    held.resolve();
    await disposal;
    const executor = await createLangGraphAdapter().prepare(
      () => graph,
      { chatModels: {} },
      { signal: new AbortController().signal },
    );
    await expect(executor.pending(instance.sessionId)).rejects.toMatchObject(
      toErrorInfo('unsupported'),
    );
    const snapshot = await graph.getState({ configurable: { thread_id: instance.sessionId } });
    expect(snapshot.tasks.filter((task) => task.interrupts.length > 0)).toHaveLength(1);
    expect(snapshot.values).toEqual({});
  } finally {
    held.resolve();
    await runtime.dispose();
  }
});

test('ID-less identity and errors omit node names; spans omit request and answer content', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const requestCanary = 'private-idless-request-canary';
  const answerCanary = 'private-idless-answer-canary';
  const nodeCanary = 'private-idless-node-canary';
  const runtime = createRuntime({
    appId: 'tests',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'tests',
      agent: (host) =>
        new web.StateGraph(web.Annotation.Root({ answer: web.Annotation<unknown> }))
          .addNode(nodeCanary, async (_, config) => {
            await ask({ request: requestInteraction }, config, {
              ...question,
              props: { question: requestCanary },
            });
            throw new Error(answerCanary);
          })
          .addEdge(web.START, nodeCanary)
          .addEdge(nodeCanary, web.END)
          .compile({ checkpointer: host.langchain.checkpointer() }),
    });
    await instance.prepare();
    const { runId } = await instance.start({});
    for await (const event of instance.events(runId)) if (event.type === 'interaction') break;
    const pending = instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('Expected an ID-less pause.');
    expect(pending.props).toEqual({ question: requestCanary });
    await instance.dispatch({
      instanceId: instance.instanceId,
      runId,
      ...pending,
      action: 'submit',
      payload: { answer: answerCanary },
    });
    for await (const _event of instance.events(runId)) {
      /* Drain the fixed failure. */
    }
    await runtime.dispose();
    expect(instance.getSnapshot().run?.error).toMatchObject(toErrorInfo('executor_error'));
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const identityAndError = JSON.stringify({
      identity: pending.interactionId,
      snapshot: instance.getSnapshot(),
    });
    for (const canary of [requestCanary, answerCanary, nodeCanary])
      expect(identityAndError).not.toContain(canary);
    for (const canary of [requestCanary, answerCanary])
      expect(serializeSpans(spans)).not.toContain(canary);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});
