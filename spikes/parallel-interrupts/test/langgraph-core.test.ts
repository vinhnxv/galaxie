// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from 'node:fs/promises';
import {
  type AgentInstance,
  createRuntime,
  defineAgentDefinition,
  type RunRequest,
  type SessionId,
  type Submission,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { Command, MemorySaver } from '@langchain/langgraph';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { readPauses, reopenSaver } from '../src/checkpoint-reader.js';
import { createFixture, DURABILITIES, type Durability } from '../src/graphs.js';
import { LangGraphExecutor, type SpikeHooks } from '../src/langgraph-executor.js';

const observations: Record<string, unknown[]> = {};
const disposables: Array<{ dispose(): Promise<void> }> = [];
const definition = defineAgentDefinition({
  id: 'spike/parallel-langgraph',
  version: '1.0.0',
  executor: 'parallel-spike-langgraph',
  input: z.unknown(),
  capabilities: {
    optional: {
      'send@1': {
        kind: 'read',
        input: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(64),
        output: z.string(),
      },
    },
  },
});

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((runtime) => runtime.dispose()));
});

afterAll(async () => {
  const url = new URL('../results/core.json', import.meta.url);
  const previous = JSON.parse(await readFile(url, 'utf8')) as Record<string, unknown>;
  await writeFile(url, `${JSON.stringify({ ...previous, L: observations }, null, 2)}\n`);
});

function probe(id: string, run: (mode: Durability) => Promise<unknown>): void {
  test.each(DURABILITIES)(`${id} (%s)`, async (mode) => {
    observations[id] ??= [];
    try {
      observations[id].push({ mode, pass: true, observation: await run(mode) });
    } catch (error) {
      observations[id].push({
        mode,
        pass: false,
        observation: error instanceof Error ? error.message : 'Probe failed.',
      });
      throw error;
    }
  });
}

async function setup(
  kind: ConstructorParameters<typeof LangGraphExecutor>[0],
  mode: Durability,
  options: {
    saver?: MemorySaver;
    store?: MemoryRecoveryStore | null;
    sessionId?: SessionId;
    hooks?: SpikeHooks;
    suppressRegistration?: boolean;
  } = {},
) {
  const saver = options.saver ?? new MemorySaver();
  const store = options.store === undefined ? new MemoryRecoveryStore() : options.store;
  const executor = new LangGraphExecutor(kind, saver, mode, options.hooks);
  const registrations: unknown[] = [];
  const prepare = executor.prepare.bind(executor);
  executor.prepare = async () => {
    const agent = await prepare();
    const register =
      (target: RunRequest['registerRestoredData']) =>
      (value: unknown): void => {
        registrations.push(structuredClone(value));
        if (!options.suppressRegistration) target?.(value);
      };
    return {
      ...agent,
      pending: (sessionId, pendingOptions) =>
        agent.pending(sessionId, {
          registerRestoredData: register(pendingOptions?.registerRestoredData),
        }),
      run: (request) =>
        agent.run({ ...request, registerRestoredData: register(request.registerRestoredData) }),
    };
  };
  let sends = 0;
  const runtime = createRuntime({
    appId: 'parallel-langgraph',
    executors: [executor],
    urlAllowlist: ['https://allowed.example'],
  });
  disposables.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: {},
    ...(store === null ? {} : { recovery: store }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    bindings: {
      'send@1': {
        kind: 'read',
        destination: 'host-server',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        invoke: async () => {
          sends++;
          return 'sent-token';
        },
      },
    },
  });
  await instance.prepare();
  return { runtime, instance, executor, saver, store, registrations, sends: () => sends };
}

async function status(instance: AgentInstance<unknown, unknown>, expected: string): Promise<void> {
  await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe(expected), {
    interval: 1,
    timeout: 2000,
  });
}

function event(instance: AgentInstance<unknown, unknown>, payload: unknown): UserInteractionEvent {
  const run = instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('Missing pending interaction.');
  return {
    instanceId: instance.instanceId,
    runId: run.runId,
    ...run.pending,
    action: 'submit',
    payload,
  };
}

async function start(f: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await f.instance.start({});
  await status(f.instance, 'waiting_input');
}

async function answer(
  f: Awaited<ReturnType<typeof setup>>,
  payload: unknown,
  expected: string,
): Promise<void> {
  expect(await f.instance.dispatch(event(f.instance, payload))).toMatchObject({
    status: 'accepted',
  });
  await status(f.instance, expected);
}

async function output(instance: AgentInstance<unknown, unknown>): Promise<unknown> {
  const run = instance.getSnapshot().run;
  if (run === undefined) throw new Error('Missing run.');
  let value: unknown;
  for await (const item of instance.events(run.runId))
    if (item.type === 'output') value = item.output;
  return value;
}

function submission(payload: string): Submission {
  return { action: 'submit', payload };
}

probe('L1', async (mode) => {
  const f = await setup('twice', mode);
  await start(f);
  const first = event(f.instance, 'first-token');
  await answer(f, 'first-token', 'waiting_input');
  const second = event(f.instance, 'second-token');
  expect(second.interactionId).toBe(`${first.interactionId}:1`);
  expect(f.instance.getSnapshot().run?.pending?.props).toEqual({ question: 'second' });
  await answer(f, 'second-token', 'succeeded');
  expect(await output(f.instance)).toMatchObject({
    answers: { first: submission('first-token'), second: submission('second-token') },
  });
  expect(f.executor.counts['twice']).toBe(3);
  return { published: ['r', 'r:1'], receipts: ['accepted', 'accepted'], bodyExecutions: 3 };
});

probe('L2', async (mode) => {
  const f = await setup('twice', mode);
  await start(f);
  const earlier = event(f.instance, 'first-token');
  await answer(f, 'first-token', 'waiting_input');
  const pending = f.instance.getSnapshot().run?.pending;
  await f.runtime.dispose();
  const reloaded = await setup('twice', mode, {
    saver: reopenSaver(f.saver),
    store: f.store,
    sessionId: f.instance.sessionId,
  });
  const restored = await reloaded.instance.restore();
  expect(restored).toBeDefined();
  expect(reloaded.instance.getSnapshot().run?.pending).toEqual(pending);
  expect(
    await reloaded.instance.dispatch({ ...earlier, instanceId: reloaded.instance.instanceId }),
  ).toMatchObject({ error: { code: 'stale' } });
  expect(
    await reloaded.instance.dispatch({
      ...earlier,
      instanceId: reloaded.instance.instanceId,
      runId: restored?.runId ?? earlier.runId,
    }),
  ).toMatchObject({ error: { code: 'duplicate' } });
  await answer(reloaded, 'second-token', 'succeeded');
  return { pendingIdentityAndPropsPreserved: true, oldRun: 'stale', restoredRun: 'duplicate' };
});

async function addPrivateUrl(saver: MemorySaver, sessionId: SessionId): Promise<void> {
  const tuple = await saver.getTuple({ configurable: { thread_id: sessionId } });
  const write = tuple?.pendingWrites?.find(([, channel]) => channel === '__interrupt__');
  if (
    tuple === undefined ||
    write === undefined ||
    typeof write[2] !== 'object' ||
    write[2] === null
  )
    throw new Error('Missing checkpoint interrupt write.');
  const pause = write[2] as { id: string; value: Record<string, unknown> };
  await saver.putWrites(
    tuple.config,
    [
      [
        '__interrupt__',
        {
          ...pause,
          value: {
            ...pause.value,
            props: { url: 'https://allowed.example/?token=private-answer-token' },
          },
        },
      ],
    ],
    write[0],
  );
}

probe('L5', async (mode) => {
  const f = await setup('twice', mode);
  await start(f);
  await answer(f, 'private-answer-token', 'waiting_input');
  await f.runtime.dispose();
  const sessionId = f.instance.sessionId;
  const validation: unknown[] = [];
  for (const suppressRegistration of [false, true]) {
    const saver = reopenSaver(f.saver);
    await addPrivateUrl(saver, sessionId);
    const reloaded = await setup('twice', mode, {
      saver,
      sessionId,
      store: null,
      suppressRegistration,
    });
    if (suppressRegistration) {
      expect(await reloaded.instance.restore()).toBeDefined();
      expect(reloaded.instance.getSnapshot().run?.status).toBe('waiting_input');
    } else {
      await expect(reloaded.instance.restore()).rejects.toMatchObject({ code: 'denied' });
      expect(reloaded.instance.getSnapshot().run).toBeUndefined();
    }
    expect(reloaded.registrations).toContainEqual(submission('private-answer-token'));
    validation.push({
      registrationSuppressed: suppressRegistration,
      restore: suppressRegistration ? 'published' : 'denied',
    });
    await reloaded.runtime.dispose();
  }
  const outbound: unknown[] = [];
  for (const suppressRegistration of [false, true]) {
    const receipts: string[] = [];
    const reloaded = await setup('twice', mode, {
      saver: reopenSaver(f.saver),
      store: null,
      sessionId,
      suppressRegistration,
      hooks: {
        afterFirst: async (earlier, _config, request) => {
          try {
            await request.capabilities.call('send@1', (earlier as Submission).payload);
            receipts.push('sent');
          } catch (error) {
            expect(error).toMatchObject({ code: 'denied' });
            receipts.push('denied');
          }
        },
      },
    });
    expect(await reloaded.instance.restore()).toBeDefined();
    expect(reloaded.registrations).toContainEqual(submission('private-answer-token'));
    await answer(reloaded, 'second-token', 'succeeded');
    expect(receipts).toEqual([suppressRegistration ? 'sent' : 'denied']);
    expect(reloaded.sends()).toBe(suppressRegistration ? 1 : 0);
    outbound.push({
      registrationSuppressed: suppressRegistration,
      receipt: receipts[0],
      hostCalls: reloaded.sends(),
    });
  }
  return { recoveryOnReload: false, urlValidation: validation, structuredOutbound: outbound };
});

probe('L8', async (mode) => {
  const saver = new MemorySaver();
  const { graph } = createFixture('twice', saver);
  const config = { configurable: { thread_id: `unstripped-${mode}` }, durability: mode };
  await graph.invoke({}, config);
  const raw = readPauses(await graph.getState(config), await saver.getTuple(config))[0]?.rawId;
  if (raw === undefined) throw new Error('Missing raw interrupt.');
  await graph.invoke(new Command({ resume: { [raw]: submission('first-token') } }), config);
  const malformed = { [`${raw}:1`]: submission('second-token') };
  const wrong = await graph.invoke(new Command({ resume: malformed }), config);
  expect(wrong.answers['second']).toEqual(malformed);
  expect(wrong.answers['second']).not.toEqual(submission('second-token'));
  const f = await setup('twice', mode);
  await start(f);
  await answer(f, 'first-token', 'waiting_input');
  await answer(f, 'second-token', 'succeeded');
  expect(await output(f.instance)).toMatchObject({
    answers: { second: submission('second-token') },
  });
  return { unstrippedMapDetected: true, strippedResumeReachedSecondCall: true };
});

probe('L3', async (mode) => {
  const f = await setup('fanout', mode);
  await start(f);
  expect(f.instance.getSnapshot().run?.pending?.props).toEqual({ question: 'askA' });
  await answer(f, 'a-token', 'waiting_input');
  expect(f.instance.getSnapshot().run?.pending?.props).toEqual({ question: 'askB' });
  await answer(f, 'b-token', 'succeeded');
  expect(await output(f.instance)).toMatchObject({
    answers: { askA: submission('a-token'), askB: submission('b-token') },
  });
  expect(f.executor.counts['join']).toBe(1);
  return { published: ['askA', 'askB'], counts: f.executor.counts };
});

probe('L4', async (mode) => {
  const windows: unknown[] = [];
  for (const window of ['a', 'b', 'c'] as const) {
    const f = await setup('fanout', mode);
    await start(f);
    if (window === 'c') await answer(f, 'a-token', 'waiting_input');
    f.executor.fault = window === 'b' ? 'afterCommit' : 'beforeResume';
    await answer(f, window === 'c' ? 'b-token' : 'a-token', 'failed');
    const accepted = await f.store?.submissions(f.instance.sessionId);
    expect(accepted?.filter((entry) => entry.status === 'accepted')).toHaveLength(1);
    await f.runtime.dispose();
    const reloaded = await setup('fanout', mode, {
      saver: reopenSaver(f.saver),
      store: f.store,
      sessionId: f.instance.sessionId,
    });
    expect(await reloaded.instance.restore()).toBeDefined();
    if (window !== 'c') {
      await status(reloaded.instance, 'waiting_input');
      await answer(reloaded, 'b-token', 'succeeded');
    } else await status(reloaded.instance, 'succeeded');
    expect(await output(reloaded.instance)).toMatchObject({
      answers: { askA: submission('a-token'), askB: submission('b-token') },
    });
    const counts = Object.fromEntries(
      ['askA', 'askB', 'join'].map((name) => [
        name,
        (f.executor.counts[name] ?? 0) + (reloaded.executor.counts[name] ?? 0),
      ]),
    );
    expect(counts).toEqual({ askA: 2, askB: 3, join: 1 });
    const statuses = (await f.store?.submissions(f.instance.sessionId))?.map(
      (entry) => entry.status,
    );
    expect(statuses).toEqual(['consumed', 'consumed']);
    windows.push({ window, counts, statuses, acceptedAnswers: ['a-token', 'b-token'] });
  }
  return { reopenedSaver: true, stableCheckpointPick: true, windows };
});

probe('L6', async (mode) => {
  const f = await setup('quietSibling', mode);
  await start(f);
  expect(f.instance.getSnapshot().run?.pending?.props).toEqual({ question: 'askA' });
  await answer(f, 'a-token', 'waiting_input');
  expect(f.instance.getSnapshot().run?.pending?.props).toEqual({ question: 'noteB' });
  await answer(f, 'b-token', 'succeeded');
  const run = f.instance.getSnapshot().run;
  if (run === undefined) throw new Error('Missing run.');
  const published: unknown[] = [];
  for await (const item of f.instance.events(run.runId))
    if (item.type === 'interaction') published.push(item.interaction.props);
  expect(published).toEqual([{ question: 'askA' }, { question: 'noteB' }]);
  return {
    published: ['askA', 'noteB'],
    completedNoWriteTaskLast: true,
    counts: f.executor.counts,
  };
});

probe('L7', async (mode) => {
  const f = await setup('fanout3', mode);
  await start(f);
  await answer(f, 'a-token', 'waiting_input');
  await answer(f, 'b-token', 'waiting_input');
  await answer(f, 'c-token', 'succeeded');
  const prefixes = Object.fromEntries(
    ['askA', 'askB', 'askC'].map((name) => [name, f.executor.counts[name] ?? 0]),
  );
  const total = Object.values(prefixes).reduce((sum, value) => sum + value, 0);
  expect(f.executor.counts['join']).toBe(1);
  return {
    branches: 3,
    prefixes,
    totalIncludingInitial: total,
    resumeOnly: total - 3,
    estimate: 6,
  };
});
