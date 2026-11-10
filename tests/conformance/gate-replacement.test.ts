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
import { expect, test } from 'vitest';
import { z } from 'zod';
import { BREAKPOINT_SHAPES, breakpointGraph, compiledSettings } from './cases/breakpoint-shapes.js';
import { GATE_CASE_NAMES, gateCases } from './cases/gates.js';
import compiledBreakpoints from './golden/compiled-breakpoints.json' with { type: 'json' };
import gateContinue from './golden/gate-continue.json' with { type: 'json' };
import gateReject from './golden/gate-reject.json' with { type: 'json' };
import { diff } from './support/diff.js';
import { normalize } from './support/normalize.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import { runGalaxie } from './support/transcript.js';

const gateGoldens = { 'gate-continue': gateContinue, 'gate-reject': gateReject };
const definition = defineAgentDefinition({
  id: 'tests/gates',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.unknown(),
});

test.each(BREAKPOINT_SHAPES)(
  'refuses compiled %s breakpoints before a run exists',
  async (shape) => {
    const saver = new web.MemorySaver();
    const { graph, counts } = breakpointGraph(web, saver, shape);
    const golden = compiledBreakpoints[shape];
    expect(compiledSettings(graph)).toEqual(golden.compiled);
    if (shape === 'child') {
      const subgraphs = (
        graph as typeof graph & {
          getSubgraphsAsync(namespace?: string, recurse?: boolean): AsyncIterable<[string, object]>;
        }
      ).getSubgraphsAsync(undefined, true);
      const discovered = [];
      for await (const [, child] of subgraphs) discovered.push(compiledSettings(child));
      expect(discovered).toContainEqual({
        ...compiledBreakpoints.child.child,
        interruptAfter: null,
      });
    }
    await expect(
      createLangGraphAdapter().prepare(
        () => graph,
        { chatModels: {} },
        {
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: golden.refusal.code, message: golden.refusal.message });
    const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
    try {
      const instance = await runtime.create(definition, {
        principalScope: 'tests',
        agent: () => graph,
      });
      await expect(instance.prepare()).rejects.toMatchObject(toErrorInfo('unsupported'));
      expect(instance.getSnapshot().run).toBeUndefined();
      await expect(instance.start({ value: 1 })).rejects.toMatchObject({ code: 'invalid' });
      expect(counts).toEqual({ prepare: 0, work: 0 });
      expect((await saver.list({}).next()).done).toBe(true);
    } finally {
      await runtime.dispose();
    }
  },
);

test.each(['before', 'after', 'wildcard', 'child'] as const)(
  'an invisible %s override fails at the pause without publishing an interaction',
  async (shape) => {
    const saver = new web.MemorySaver();
    const { graph, counts } = breakpointGraph(web, saver, shape, true);
    const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'tests/backstop',
          version: '1.0.0',
          executor: 'langgraph-js',
          input: z.unknown(),
        }),
        { principalScope: 'tests', agent: () => graph },
      );
      await instance.prepare();
      const { runId } = await instance.start({ value: 1 });
      const events = [];
      for await (const event of instance.events(runId)) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
      expect(events.some(({ type }) => type === 'interaction' || type === 'output')).toBe(false);
      expect(instance.getSnapshot().run?.pending).toBeUndefined();
      expect(counts).toEqual({ prepare: shape === 'wildcard' ? 0 : 1, work: 0 });
    } finally {
      await runtime.dispose();
    }
  },
);

test.each(GATE_CASE_NAMES)('%s matches native with zero differences', async (name) => {
  const transcript = await runGalaxie(gateCases[name]);
  expect(diff(gateGoldens[name], normalize(transcript))).toEqual([]);
});

test.each(GATE_CASE_NAMES)('%s remains resolved after restore in a new runtime', async (name) => {
  const saver = new web.MemorySaver();
  const paused = await runGalaxie(gateCases[name], () => saver, true);
  const first = await saver.list({}).next();
  const sessionId = first.value?.config.configurable?.['thread_id'] as SessionId;
  expect(typeof sessionId).toBe('string');
  const restored = await runGalaxie(gateCases[name], () => saver, false, sessionId);
  expect(restored.outcome).toEqual({ status: 'succeeded' });
  expect(restored.pauses).toEqual(paused.pauses);
  expect(normalize({ pauses: restored.pauses })).toEqual({ pauses: gateGoldens[name].pauses });
  expect(restored.state.next).toEqual([]);
  expect(restored.final).toEqual(
    name === 'gate-continue'
      ? { value: 2, decision: 'continue', counts: { prepare: 0, work: 1 } }
      : { value: 1, decision: 'reject' },
  );
  const work = restored.events.updates.filter(
    ({ data }) => typeof data === 'object' && data !== null && 'work' in data,
  );
  expect(work).toHaveLength(name === 'gate-continue' ? 1 : 0);
  await expect(runGalaxie(gateCases[name], () => saver, false, sessionId)).rejects.toThrow(
    'The conformance session has no pending interaction.',
  );
});

test.each(GATE_CASE_NAMES)('%s refuses a repeated answer after completion', async (name) => {
  const fixture = gateCases[name];
  const runtime = createRuntime({ appId: 'tests', executors: [createLangGraphAdapter()] });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'tests',
      agent: (host) =>
        fixture.factory(web, new ScriptedChatModel({}), host.langchain.checkpointer(), undefined, {
          request: requestInteraction,
        }),
    });
    await instance.prepare();
    const { runId } = await instance.start(fixture.input);
    for await (const event of instance.events(runId)) if (event.type === 'interaction') break;
    const pending = instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('Expected a gate.');
    const submission = fixture.resumes?.[0];
    if (submission === undefined) throw new Error('Expected a gate answer.');
    const event = { instanceId: instance.instanceId, runId, ...pending, ...submission };
    expect((await instance.dispatch(event)).status).toBe('accepted');
    const outputs = [];
    for await (const result of instance.events(runId))
      if (result.type === 'output') outputs.push(result.output);
    expect(outputs).toEqual([gateGoldens[name].final]);
    expect(await instance.dispatch(event)).toMatchObject({
      status: 'rejected',
      error: { code: expect.stringMatching(/^(stale|duplicate)$/) },
    });
  } finally {
    await runtime.dispose();
  }
});
