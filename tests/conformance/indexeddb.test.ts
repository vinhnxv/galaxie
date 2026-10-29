// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { Submission } from '@galaxie/core';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import * as web from '@langchain/langgraph/web';
import { afterEach, expect, test } from 'vitest';
import { CASE_NAMES, type CaseName, cases } from './cases/index.js';
import branching from './golden/branching.json' with { type: 'json' };
import capability from './golden/capability.json' with { type: 'json' };
import interruptDurabilityExit from './golden/interrupt-durability-exit.json' with { type: 'json' };
import interruptDurabilitySync from './golden/interrupt-durability-sync.json' with { type: 'json' };
import interruptResume from './golden/interrupt-resume.json' with { type: 'json' };
import interruptSequence from './golden/interrupt-sequence.json' with { type: 'json' };
import interruptSubgraph from './golden/interrupt-subgraph.json' with { type: 'json' };
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
