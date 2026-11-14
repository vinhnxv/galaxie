// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  type PendingInteraction,
  type RecoveryStore,
  type RunId,
  type SessionId,
  type Submission,
} from '@galaxie-ai/core';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import * as web from '@langchain/langgraph/web';
import { afterEach, expect, expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import { GATE_CASE_NAMES, gateCases } from './cases/gates.js';
import { IDLESS_CASE_NAMES, idlessCases } from './cases/idless.js';
import { CASE_NAMES, type CaseName, cases } from './cases/index.js';
import { interruptTwiceCases, resumes as repeatedAnswers } from './cases/interrupt-twice.js';
import branching from './golden/branching.json' with { type: 'json' };
import capability from './golden/capability.json' with { type: 'json' };
import gateContinue from './golden/gate-continue.json' with { type: 'json' };
import gateReject from './golden/gate-reject.json' with { type: 'json' };
import idlessSequence from './golden/idless-sequence.json' with { type: 'json' };
import idlessSubmit from './golden/idless-submit.json' with { type: 'json' };
import interruptDurabilityExit from './golden/interrupt-durability-exit.json' with { type: 'json' };
import interruptDurabilitySync from './golden/interrupt-durability-sync.json' with { type: 'json' };
import interruptResume from './golden/interrupt-resume.json' with { type: 'json' };
import interruptSequence from './golden/interrupt-sequence.json' with { type: 'json' };
import interruptSubgraph from './golden/interrupt-subgraph.json' with { type: 'json' };
import interruptTwice from './golden/interrupt-twice.json' with { type: 'json' };
import linear from './golden/linear.json' with { type: 'json' };
import modelFailure from './golden/model-failure.json' with { type: 'json' };
import modelWithoutConfig from './golden/model-without-config.json' with { type: 'json' };
import stepLimit from './golden/step-limit.json' with { type: 'json' };
import subgraph from './golden/subgraph.json' with { type: 'json' };
import { diff } from './support/diff.js';
import { compatibilityMatrix } from './support/matrix.js';
import { normalize } from './support/normalize.js';
import { ScriptedChatModel } from './support/scripted-chat-model.js';
import { type ConformanceGraph, runGalaxie } from './support/transcript.js';

const goldens: Record<CaseName, unknown> = {
  'interrupt-durability-exit': interruptDurabilityExit,
  'interrupt-durability-sync': interruptDurabilitySync,
  'interrupt-subgraph': interruptSubgraph,
  'interrupt-sequence': interruptSequence,
  'interrupt-resume': interruptResume,
  linear,
  capability,
  'step-limit': stepLimit,
  branching,
  subgraph,
  'model-without-config': modelWithoutConfig,
  'model-failure': modelFailure,
};

const databases: string[] = [];
const savers: IndexedDBSaver[] = [];

async function open(
  databaseName = `galaxie-conformance-${crypto.randomUUID()}`,
): Promise<IndexedDBSaver> {
  if (!databases.includes(databaseName)) databases.push(databaseName);
  const saver = await IndexedDBSaver.open({
    appId: 'conformance',
    principalScope: 'conformance',
    databaseName,
  });
  savers.push(saver);
  return saver;
}

afterEach(async () => {
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Conformance database cleanup was blocked.'));
    });
  }
});

test.each(CASE_NAMES)(
  '%s with IndexedDB matches the existing Chromium differences',
  async (name) => {
    const saver = await open();
    const transcript = await runGalaxie(cases[name], () => saver);
    expect((await saver.list({}).next()).done).toBe(false);
    expect(transcript.outcome).toEqual(
      name === 'model-failure'
        ? { status: 'failed', errorType: 'FixtureModelError' }
        : name === 'step-limit'
          ? { status: 'failed', errorType: 'GraphRecursionError' }
          : { status: 'succeeded' },
    );
    const differences = diff(goldens[name], normalize(transcript)).sort();
    const listed = compatibilityMatrix.find(
      (entry) => entry.case === name && entry.lane === 'galaxie-chromium',
    );
    expect(differences).toEqual(listed?.differences.toSorted() ?? []);
  },
);

const reloadCases = {
  'interrupt-resume': interruptResume,
  'interrupt-subgraph': interruptSubgraph,
  'interrupt-durability-sync': interruptDurabilitySync,
  'interrupt-durability-exit': interruptDurabilityExit,
} as const;

const gateGoldens = { 'gate-continue': gateContinue, 'gate-reject': gateReject };

test.each(GATE_CASE_NAMES)(
  '%s with IndexedDB matches native with zero differences',
  async (name) => {
    const saver = await open();
    expect(
      diff(gateGoldens[name], normalize(await runGalaxie(gateCases[name], () => saver))),
    ).toEqual([]);
  },
);

test.each(GATE_CASE_NAMES)(
  '%s stays resolved after IndexedDB close, reopen and restore',
  async (name) => {
    const databaseName = `galaxie-gate-restore-${crypto.randomUUID()}`;
    const saver = await open(databaseName);
    const paused = await runGalaxie(gateCases[name], () => saver, true);
    const first = await saver.list({}).next();
    const sessionId = first.value?.config.configurable?.['thread_id'] as SessionId;
    expect(typeof sessionId).toBe('string');
    saver.close();
    const reopened = await open(databaseName);
    const restored = await runGalaxie(gateCases[name], () => reopened, false, sessionId);
    expect(restored.outcome).toEqual({ status: 'succeeded' });
    expect(restored.pauses).toEqual(paused.pauses);
    expect(normalize({ pauses: restored.pauses })).toEqual({ pauses: gateGoldens[name].pauses });
    expect(restored.state.next).toEqual([]);
    expect(restored.final).toEqual(
      name === 'gate-continue'
        ? { value: 2, decision: 'continue', counts: { prepare: 0, work: 1 } }
        : { value: 1, decision: 'reject' },
    );
    expect(
      restored.events.updates.filter(
        ({ data }) => typeof data === 'object' && data !== null && 'work' in data,
      ),
    ).toHaveLength(name === 'gate-continue' ? 1 : 0);
    reopened.close();
    const completed = await open(databaseName);
    await expect(runGalaxie(gateCases[name], () => completed, false, sessionId)).rejects.toThrow(
      'The conformance session has no pending interaction.',
    );
  },
);

test('the IndexedDB recovery port conforms structurally to the core contract', async () => {
  const saver = await open();
  expectTypeOf(saver.recovery).toMatchTypeOf<RecoveryStore>();
});

function rebuild(name: keyof typeof reloadCases, saver: IndexedDBSaver): ConformanceGraph {
  const fixture = cases[name];
  return fixture.factory(web, new ScriptedChatModel(fixture.script), saver, undefined, {
    // The browser shim needs explicit config after the fixture's await.
    request: (value, config) =>
      AsyncLocalStorageProviderSingleton.runWithConfig(config, () =>
        web.interrupt<unknown, Submission>(value),
      ),
  });
}

async function resume(
  graph: ConformanceGraph,
  config: web.LangGraphRunnableConfig,
  id: string,
  submission: Submission,
): Promise<unknown[]> {
  const stream = await graph.stream(new web.Command({ resume: { [id]: submission } }), {
    ...config,
    signal: new AbortController().signal,
    streamMode: ['updates'],
    subgraphs: true,
  });
  const updates: unknown[] = [];
  for await (const update of stream) updates.push(update);
  return updates;
}

test.each(Object.keys(reloadCases) as (keyof typeof reloadCases)[])(
  '%s resumes the committed interrupt after rebuilding and ignores a repeated completed resume',
  async (name) => {
    const databaseName = `galaxie-reload-${crypto.randomUUID()}`;
    const saver = await open(databaseName);
    const paused = await runGalaxie(cases[name], () => saver, true);
    expect(paused.outcome).toEqual({ status: 'succeeded' });
    expect(paused.pauses).toHaveLength(1);
    const first = await saver.list({}).next();
    const threadId: unknown = first.value?.config.configurable?.['thread_id'];
    expect(typeof threadId).toBe('string');
    const config = { configurable: { thread_id: threadId } };
    const interrupt = paused.pauses?.[0]?.interrupts[0];
    if (interrupt === undefined) throw new Error('The reload fixture did not pause.');
    saver.close();

    const reopened = await open(databaseName);
    const graph = rebuild(name, reopened);
    const pending = await graph.getState(config);
    const interrupts = pending.tasks
      .flatMap((task) => task.interrupts)
      .map(({ id, value }) => ({ id, value }));
    expect(interrupts).toEqual([interrupt]);
    const golden = reloadCases[name];
    expect(normalize({ pauses: [{ interrupts }] })).toEqual({
      pauses: [{ interrupts: golden.pauses[0]?.interrupts }],
    });
    expect(pending.next).toEqual(paused.state.next);
    expect(pending.next).toEqual(
      golden.checkpoints[(golden.pauses[0]?.historyLength ?? 0) - 1]?.next,
    );

    const submission = cases[name].resumes?.[0];
    if (submission === undefined) throw new Error('The reload fixture has no submission.');
    if (interrupt.id === undefined) throw new Error('The ID-bearing fixture has no interrupt ID.');
    await resume(graph, config, interrupt.id, submission);
    const finished = await graph.getState(config);
    const { counts, ...values } = finished.values as Record<string, unknown>;
    expect(values).toEqual({ value: golden.final.value, answer: golden.final.answer });
    expect(finished.next).toEqual(golden.state.next);
    expect(counts).toEqual(
      name === 'interrupt-subgraph' ? { callSub: 1, s1: 0, sask: 1 } : { prepare: 0, ask: 1 },
    );
    reopened.close();

    const afterCrash = await open(databaseName);
    const rebuilt = rebuild(name, afterCrash);
    expect(await resume(rebuilt, config, interrupt.id, submission)).toEqual([]);
    const repeated = await rebuilt.getState(config);
    expect(repeated.values).toEqual(finished.values);
    expect(repeated.next).toEqual([]);
  },
);

test.each(Object.keys(reloadCases) as (keyof typeof reloadCases)[])(
  '%s restores through core after closing and reopening IndexedDB',
  async (name) => {
    const databaseName = `galaxie-core-restore-${crypto.randomUUID()}`;
    const saver = await open(databaseName);
    const paused = await runGalaxie(cases[name], () => saver, true);
    const first = await saver.list({}).next();
    const sessionId = first.value?.config.configurable?.['thread_id'] as SessionId;
    expect(typeof sessionId).toBe('string');
    saver.close();

    const reopened = await open(databaseName);
    const restored = await runGalaxie(cases[name], () => reopened, false, sessionId);
    const golden = reloadCases[name];
    expect(restored.outcome).toEqual({ status: 'succeeded' });
    expect(restored.pauses).toEqual(paused.pauses);
    expect(normalize({ pauses: restored.pauses })).toEqual({ pauses: golden.pauses });
    expect(paused.state.next).toEqual(
      golden.checkpoints[(golden.pauses[0]?.historyLength ?? 0) - 1]?.next,
    );
    const { counts, ...values } = restored.final as Record<string, unknown>;
    expect(values).toEqual({ value: golden.final.value, answer: golden.final.answer });
    expect(restored.state.next).toEqual(golden.state.next);
    expect(counts).toEqual(
      name === 'interrupt-subgraph' ? { callSub: 1, s1: 0, sask: 1 } : { prepare: 0, ask: 1 },
    );
  },
);

const idlessGoldens = { 'idless-submit': idlessSubmit, 'idless-sequence': idlessSequence };
test.each(IDLESS_CASE_NAMES)(
  '%s with IndexedDB matches native with zero differences',
  async (name) => {
    const saver = await open();
    expect(
      diff(idlessGoldens[name], normalize(await runGalaxie(idlessCases[name], () => saver))),
    ).toEqual([]);
  },
);

test.each(IDLESS_CASE_NAMES)('%s restores after IndexedDB close and reopen', async (name) => {
  const databaseName = `galaxie-idless-restore-${crypto.randomUUID()}`;
  const saver = await open(databaseName);
  const paused = await runGalaxie(idlessCases[name], () => saver, true);
  const tuple = await saver.list({}).next();
  const sessionId = tuple.value?.config.configurable?.['thread_id'] as SessionId;
  saver.close();
  const reopened = await open(databaseName);
  const restored = await runGalaxie(idlessCases[name], () => reopened, false, sessionId);
  expect(restored.pauses?.[0]).toEqual(paused.pauses?.[0]);
  expect(restored.outcome).toEqual({ status: 'succeeded' });
  expect(restored.final).toMatchObject({
    answer: idlessSubmit.final.answer,
    applications: name === 'idless-submit' ? 1 : 2,
  });
  expect(restored.state.next).toEqual([]);
  reopened.close();
  const completed = await open(databaseName);
  await expect(runGalaxie(idlessCases[name], () => completed, false, sessionId)).rejects.toThrow(
    'The conformance session has no pending interaction.',
  );
});

test('interrupt-twice with IndexedDB matches native with zero differences', async () => {
  const saver = await open();
  expect(
    diff(
      interruptTwice,
      normalize(await runGalaxie(interruptTwiceCases['interrupt-twice'], () => saver)),
    ),
  ).toEqual([]);
});

async function repeatedPause(
  instance: AgentInstance<unknown, unknown>,
  runId: RunId,
): Promise<PendingInteraction | undefined> {
  for await (const event of instance.events(runId)) {
    if (event.type === 'error') throw new Error(`The reloaded run failed: ${event.error.code}`);
    const pending = instance.getSnapshot().run?.pending;
    if (event.type === 'interaction' && pending?.interactionId === event.interaction.interactionId)
      return pending;
  }
  return undefined;
}

test.each(
  ['sync', 'async', 'exit'].flatMap((mode) => [0, 1].map((ordinal) => ({ mode, ordinal }))),
)(
  'interrupt-twice restores ordinal $ordinal after IndexedDB close and reopen with $mode durability',
  async ({ mode, ordinal }) => {
    const databaseName = `galaxie-repeated-restore-${crypto.randomUUID()}`;
    const active: Array<{ dispose(): Promise<void> }> = [];
    const order: Array<{ kind: 'registered'; value: unknown } | { kind: 'pending'; id: string }> =
      [];
    const make = async (saver: IndexedDBSaver, sessionId?: SessionId) => {
      const adapter = createLangGraphAdapter();
      const runtime = createRuntime({
        appId: 'conformance',
        executors: [
          {
            ...adapter,
            async prepare(
              agent: Parameters<typeof adapter.prepare>[0],
              services: Parameters<typeof adapter.prepare>[1],
              options: Parameters<typeof adapter.prepare>[2],
            ) {
              const executor = await adapter.prepare(agent, services, options);
              return {
                ...executor,
                async pending(id, options) {
                  const pending = await executor.pending(
                    id,
                    options === undefined
                      ? undefined
                      : {
                          registerRestoredData(value) {
                            order.push({ kind: 'registered', value });
                            options.registerRestoredData?.(value);
                          },
                        },
                  );
                  if (pending !== undefined)
                    order.push({ kind: 'pending', id: pending.interactionId });
                  return pending;
                },
              };
            },
          },
        ],
      });
      active.push(runtime);
      const fixture = interruptTwiceCases['interrupt-twice'];
      const graph = fixture.factory(web, new ScriptedChatModel(fixture.script), saver, undefined, {
        request: requestInteraction,
      });
      const instance = await runtime.create(
        {
          id: 'conformance/repeated-reload',
          version: '1.0.0',
          executor: 'langgraph-js',
          input: z.unknown(),
        },
        {
          principalScope: 'conformance',
          recovery: saver.recovery,
          ...(sessionId === undefined ? {} : { sessionId }),
          agent: () =>
            (
              graph as ConformanceGraph & {
                withConfig(config: { durability: string }): ConformanceGraph;
              }
            ).withConfig({ durability: mode }),
        },
      );
      await instance.prepare();
      return { runtime, instance, graph };
    };
    try {
      const saver = await open(databaseName);
      const first = await make(saver);
      const started = await first.instance.start({ value: 1 });
      const initial = await repeatedPause(first.instance, started.runId);
      if (initial === undefined) throw new Error('Expected the first persisted question.');
      let pending = initial;
      if (ordinal === 1) {
        expect(
          await first.instance.dispatch({
            instanceId: first.instance.instanceId,
            runId: started.runId,
            ...pending,
            ...repeatedAnswers[0],
          }),
        ).toMatchObject({ status: 'accepted' });
        const second = await repeatedPause(first.instance, started.runId);
        if (second === undefined) throw new Error('Expected the second persisted question.');
        pending = second;
      }
      expect(pending.interactionId).toBe(
        ordinal === 0 ? initial.interactionId : `${initial.interactionId}:1`,
      );
      await first.runtime.dispose();
      saver.close();
      order.length = 0;
      const reopened = await open(databaseName);
      const restored = await make(reopened, first.instance.sessionId);
      const run = await restored.instance.restore();
      if (run === undefined) throw new Error('Expected the persisted question after reload.');
      expect(restored.instance.getSnapshot().run?.pending).toEqual(pending);
      if (ordinal === 1) {
        const registered = order.findIndex(
          (entry) =>
            entry.kind === 'registered' &&
            JSON.stringify(entry.value) === JSON.stringify(repeatedAnswers[0]),
        );
        const published = order.findIndex(
          (entry) => entry.kind === 'pending' && entry.id === pending.interactionId,
        );
        expect(registered).toBeGreaterThanOrEqual(0);
        expect(registered).toBeLessThan(published);
        expect(restored.instance.getSnapshot().run?.labels).toContain('private-user');
      }
      for (let index = ordinal; index < 2; index++) {
        const current = restored.instance.getSnapshot().run?.pending;
        if (current === undefined) throw new Error('Expected an unanswered restored question.');
        expect(current.interactionId).toBe(
          index === 0 ? initial.interactionId : `${initial.interactionId}:1`,
        );
        const answer = repeatedAnswers[index];
        if (answer === undefined) throw new Error('Expected an answer for the restored question.');
        expect(
          await restored.instance.dispatch({
            instanceId: restored.instance.instanceId,
            runId: run.runId,
            ...current,
            ...answer,
          }),
        ).toMatchObject({ status: 'accepted' });
        await repeatedPause(restored.instance, run.runId);
      }
      expect(restored.instance.getSnapshot().run?.status).toBe('succeeded');
      expect(restored.instance.getSnapshot().run?.pending).toBeUndefined();
      const state = await restored.graph.getState({
        configurable: { thread_id: restored.instance.sessionId },
      });
      expect(state.values).toEqual({
        value: 1,
        first: 'first',
        second: false,
        executions: 2 - ordinal,
      });
      expect(state.next).toEqual([]);
      expect(await reopened.recovery.submissions(restored.instance.sessionId)).toMatchObject([
        { interactionId: initial.interactionId, status: 'consumed' },
        { interactionId: `${initial.interactionId}:1`, status: 'consumed' },
      ]);
      await restored.runtime.dispose();
      reopened.close();
      const completed = await make(await open(databaseName), first.instance.sessionId);
      expect(await completed.instance.restore()).toBeUndefined();
    } finally {
      await Promise.all(active.map((runtime) => runtime.dispose()));
    }
  },
);
