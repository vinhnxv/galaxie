// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { Command, MemorySaver } from '@langchain/langgraph';
import { afterAll, expect, test } from 'vitest';
import { readPauses, reopenSaver, taskDone, taskResumeValues } from '../src/checkpoint-reader.js';
import { createFixture, DURABILITIES, type Durability } from '../src/graphs.js';

interface Observation {
  readonly probe: string;
  readonly mode: Durability;
  readonly pass: boolean;
  readonly observation: unknown;
}
const observations: Observation[] = [];

function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string')
      return item.replace(
        /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32}/g,
        (id) => {
          if (!ids.has(id)) ids.set(id, `id-${ids.size + 1}`);
          return ids.get(id) as string;
        },
      );
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, item]) => [visit(key), visit(item)]),
      );
    return item;
  };
  return visit(value);
}

function record(
  probe: string,
  mode: Durability,
  observation: unknown,
  assertion: () => void,
  designPass = true,
): void {
  try {
    assertion();
    observations.push({ probe, mode, pass: designPass, observation: normalize(observation) });
  } catch (error) {
    observations.push({ probe, mode, pass: false, observation: normalize(observation) });
    throw error;
  }
}

afterAll(() => {
  observations.sort(
    (left, right) =>
      Number(left.probe.slice(1)) - Number(right.probe.slice(1)) ||
      DURABILITIES.indexOf(left.mode) - DURABILITIES.indexOf(right.mode),
  );
  writeFileSync(
    new URL('../results/native.json', import.meta.url),
    `${JSON.stringify({ environment: { node: process.version, langgraph: '1.5.1', checkpoint: '1.2.0', models: 'scripted only' }, probes: observations }, null, 2)}\n`,
  );
});

test.each(DURABILITIES)('G2 repeated pauses and raw-ID resume (%s)', async (mode) => {
  const saver = new MemorySaver();
  const { graph, counts } = createFixture('twice', saver);
  const config = { configurable: { thread_id: `native-twice-${mode}` }, durability: mode };
  await graph.invoke({}, config);
  const before = await graph.getState(config);
  const first = readPauses(before, await saver.getTuple(config))[0];
  expect(first).toBeDefined();
  if (!first) return;
  await graph.invoke(new Command({ resume: { [first.rawId]: 'answer-first' } }), config);
  const middle = await graph.getState(config);
  const tuple = await saver.getTuple(config);
  const second = readPauses(middle, tuple)[0];
  record(
    'N1',
    mode,
    { ids: [first.rawId, second?.rawId], questions: [first.value, second?.value] },
    () => {
      expect(second?.rawId).toBe(first.rawId);
      expect(second?.value).toMatchObject({ props: { question: 'second' } });
    },
  );
  record(
    'N2',
    mode,
    {
      resumeValues: taskResumeValues(tuple, first.taskId),
      ordinal: second?.ordinal,
      interactionId: second?.interactionId,
      resumeWriteOwners: tuple?.pendingWrites
        ?.filter(([, channel]) => channel === '__resume__')
        .map(([id]) => (id === first.taskId ? 'task' : id === first.rawId ? 'interrupt' : 'other')),
    },
    () => {
      expect(taskResumeValues(tuple, first.taskId)).toEqual(['answer-first']);
      expect(second?.ordinal).toBe(1);
      expect(second?.interactionId).toBe(`${first.rawId}:1`);
    },
  );
  const output = await graph.invoke(
    new Command({ resume: { [first.rawId]: 'answer-second' } }),
    config,
  );
  record('N3', mode, { output, counts }, () => {
    expect(output.answers).toEqual({ first: 'answer-first', second: 'answer-second' });
    expect(counts['twice']).toBe(3);
    expect(readPauses(middle, tuple)[0]?.ordinal).toBe(1);
  });
});

test.each(DURABILITIES)(
  'N8 suffix-keyed native resume is not the intended answer (%s)',
  async (mode) => {
    const saver = new MemorySaver();
    const { graph } = createFixture('twice', saver);
    const config = { configurable: { thread_id: `native-suffix-${mode}` }, durability: mode };
    await graph.invoke({}, config);
    const raw = readPauses(await graph.getState(config), await saver.getTuple(config))[0]?.rawId;
    expect(raw).toBeDefined();
    if (!raw) return;
    await graph.invoke(new Command({ resume: { [raw]: 'answer-first' } }), config);
    const output = await graph.invoke(
      new Command({ resume: { [`${raw}:1`]: 'answer-second' } }),
      config,
    );
    record('N8', mode, { intended: 'answer-second', received: output.answers['second'] }, () => {
      expect(output.answers['second']).toEqual({ [`${raw}:1`]: 'answer-second' });
      expect(output.answers['second']).not.toBe('answer-second');
    });
  },
);

test.each(DURABILITIES)('G1 parallel tasks, committed order and completion (%s)', async (mode) => {
  const saver = new MemorySaver();
  const { graph, counts } = createFixture('fanout', saver);
  const config = { configurable: { thread_id: `native-fanout-${mode}` }, durability: mode };
  await graph.invoke({}, config);
  const initial = await graph.getState(config);
  const firstTuple = await saver.getTuple(config);
  const pauses = readPauses(initial, firstTuple);
  const sendSaver = new MemorySaver();
  const send = createFixture('sendFanout', sendSaver);
  const sendConfig = { configurable: { thread_id: `native-send-${mode}` }, durability: mode };
  await send.graph.invoke({}, sendConfig);
  const sends = readPauses(
    await send.graph.getState(sendConfig),
    await sendSaver.getTuple(sendConfig),
  );
  record(
    'N4',
    mode,
    {
      fanout: pauses.map(({ rawId, taskId }) => ({ rawId, taskId })),
      sendFanout: sends.map(({ rawId, taskId }) => ({ rawId, taskId })),
    },
    () => {
      expect(pauses).toHaveLength(2);
      expect(sends).toHaveLength(2);
      expect(new Set(pauses.map(({ rawId }) => rawId)).size).toBe(2);
      expect(new Set(sends.map(({ rawId }) => rawId)).size).toBe(2);
    },
  );
  const first = pauses[0];
  const sibling = pauses[1];
  expect(first).toBeDefined();
  expect(sibling).toBeDefined();
  if (!first || !sibling) return;
  const repeated: string[][] = [];
  for (let read = 0; read < 10; read++)
    repeated.push(
      readPauses(await graph.getState(config), await saver.getTuple(config)).map(
        ({ interactionId }) => interactionId,
      ),
    );
  const prefixBefore = { ...counts };
  await graph.invoke(new Command({ resume: { [first.rawId]: 'answer-A' } }), config);
  const partial = await graph.getState(config);
  const partialTuple = await saver.getTuple(config);
  const remaining = readPauses(partial, partialTuple);
  const reversed = reopenSaver(saver, true);
  const reopenedGraph = createFixture('fanout', reversed).graph;
  const reversedState = await reopenedGraph.getState(config);
  const reversedPauses = readPauses(reversedState, await reversed.getTuple(config));
  const quietSaver = new MemorySaver();
  const quiet = createFixture('quietSibling', quietSaver);
  const quietConfig = { configurable: { thread_id: `native-quiet-${mode}` }, durability: mode };
  await quiet.graph.invoke({}, quietConfig);
  const quietBefore = await quiet.graph.getState(quietConfig);
  const note = quietBefore.tasks.find(({ name }) => name === 'noteB');
  const noteId = note?.interrupts[0]?.id;
  expect(noteId).toBeDefined();
  if (!noteId || !note) return;
  await quiet.graph.invoke(new Command({ resume: { [noteId]: 'quiet-answer' } }), quietConfig);
  const quietTuple = await quietSaver.getTuple(quietConfig);
  const quietPauses = readPauses(await quiet.graph.getState(quietConfig), quietTuple);
  record(
    'N5',
    mode,
    {
      completedA: taskDone(partialTuple, first.taskId),
      remainingIds: remaining.map(({ rawId }) => rawId),
      quietDone: taskDone(quietTuple, note.id),
      quietDoneChannels: quietTuple?.pendingWrites
        ?.filter(([id]) => id === note.id)
        .map(([, channel]) => channel),
      quietRemaining: quietPauses.map(({ value }) => value),
      reason:
        'Completed no-state-write task has a resume write, so the runner does not add NO_WRITES; stale interrupt remains indistinguishable.',
    },
    () => {
      expect(taskDone(partialTuple, first.taskId)).toBe(true);
      expect(remaining.map(({ rawId }) => rawId)).toEqual([sibling.rawId]);
      expect(taskDone(quietTuple, note.id)).toBe(false);
      expect(
        quietTuple?.pendingWrites?.some(
          ([id, channel]) => id === note.id && channel === '__no_writes__',
        ),
      ).toBe(false);
      expect(quietPauses).toHaveLength(2);
      expect(quietPauses[1]?.value).toMatchObject({ props: { question: 'noteB' } });
    },
    false,
  );
  const order = pauses.map(({ interactionId }) => interactionId);
  const taskOrderStable =
    JSON.stringify(initial.tasks.map(({ name }) => name)) ===
      JSON.stringify(partial.tasks.map(({ name }) => name)) &&
    JSON.stringify(partial.tasks.map(({ name }) => name)) ===
      JSON.stringify(reversedState.tasks.map(({ name }) => name));
  record(
    'N6',
    mode,
    {
      order,
      repeated,
      afterPartial: remaining.map(({ interactionId }) => interactionId),
      afterReopenAndReversedWrites: reversedPauses.map(({ interactionId }) => interactionId),
      taskOrderStable,
      pickRule: 'task order, raw interrupt ID, ordinal',
    },
    () => {
      expect(repeated.every((value) => JSON.stringify(value) === JSON.stringify(order))).toBe(true);
      expect(remaining.map(({ interactionId }) => interactionId)).toEqual(order.slice(1));
      expect(reversedPauses.map(({ interactionId }) => interactionId)).toEqual(order.slice(1));
      expect(taskOrderStable).toBe(true);
    },
  );
  const prefixAfterPartial = { ...counts };
  const output = await graph.invoke(
    new Command({ resume: { [sibling.rawId]: 'answer-B' } }),
    config,
  );
  record('N7', mode, { prefixBefore, prefixAfterPartial, finalCounts: counts, output }, () => {
    expect(counts['join']).toBe(1);
    expect(output.answers).toEqual({ askA: 'answer-A', askB: 'answer-B' });
    expect(prefixAfterPartial['askB']).toBe(2);
    expect(counts['askB']).toBe(3);
  });
});

test.each(DURABILITIES)('N9 child pause checkpoint discoverability (%s)', async (mode) => {
  const saver = new MemorySaver();
  const { graph } = createFixture('childTwice', saver);
  const config = { configurable: { thread_id: `native-child-${mode}` }, durability: mode };
  await graph.invoke({}, config);
  const first = (await graph.getState(config)).tasks[0]?.interrupts[0]?.id;
  expect(first).toBeDefined();
  if (!first) return;
  await graph.invoke(new Command({ resume: { [first]: 'answer-first' } }), config);
  const parent = await graph.getState(config, { subgraphs: true });
  const child = parent.tasks[0]?.state;
  const childSnapshot = child && 'tasks' in child ? child : undefined;
  const childTuple = childSnapshot ? await saver.getTuple(childSnapshot.config) : undefined;
  const childPauses = childSnapshot ? readPauses(childSnapshot, childTuple) : [];
  record(
    'N9',
    mode,
    {
      childSnapshotLocated: childSnapshot !== undefined,
      resumeValues: childPauses[0]?.resumeValues ?? [],
      ordinal: childPauses[0]?.ordinal ?? null,
      executorShape: 'refused: spike executor does not traverse child checkpoint namespaces',
    },
    () => {
      expect(childSnapshot).toBeUndefined();
      expect(childPauses).toEqual([]);
    },
    false,
  );
});
