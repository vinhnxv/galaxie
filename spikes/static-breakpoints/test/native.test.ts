// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { Command, MemorySaver } from '@langchain/langgraph';
import { afterAll, expect, test } from 'vitest';
import { reopenSaver } from '../src/checkpoint-reader.js';
import { createFixture, DURABILITIES, type FixtureKind } from '../src/graphs.js';
import { normalize, type Observation, writeEvidence } from './evidence.js';

const observations: Observation[] = [];
afterAll(() => writeEvidence('native', observations));

test.each(DURABILITIES)('native observations (%s)', async (mode) => {
  const config = { configurable: { thread_id: `native-${mode}` }, durability: mode };
  const record = (probe: string, observation: unknown, pass = true): void => {
    observations.push({ probe, mode, pass, observation: normalize(observation) });
  };
  const setup = (kind: FixtureKind) => {
    const saver = new MemorySaver();
    return { saver, ...createFixture(kind, saver) };
  };
  const before = setup('before');
  const updates = [];
  for await (const chunk of await before.graph.stream({}, { ...config, streamMode: 'updates' }))
    updates.push(chunk);
  const snap = await before.graph.getState(config);
  expect(snap.next).toEqual(['work']);
  expect(snap.tasks.every((task) => task.interrupts.length === 0 && task.error === undefined)).toBe(
    true,
  );
  expect(before.counts).toEqual({ prepare: 1 });
  expect(updates).toContainEqual({ __interrupt__: [] });
  expect(before.graph.interruptBefore).toEqual(['work']);
  record('S1', {
    next: snap.next,
    tasks: snap.tasks.map(({ id, name, interrupts }) => ({ id, name, interrupts })),
    counts: before.counts,
    updates,
    compiledBefore: before.graph.interruptBefore,
  });

  const after = setup('after');
  await after.graph.invoke({}, config);
  const afterSnap = await after.graph.getState(config);
  const afterTuple = await after.saver.getTuple(config);
  const parent =
    afterTuple?.parentConfig === undefined
      ? undefined
      : await after.graph.getState(afterTuple.parentConfig);
  expect(afterSnap.next).toEqual(['work']);
  expect(after.counts).toEqual({ prepare: 1 });
  const reopenedAfter = createFixture('after', reopenSaver(after.saver, true));
  for (let i = 0; i < 10; i++)
    expect((await after.graph.getState(config)).metadata).toEqual(afterSnap.metadata);
  expect((await reopenedAfter.graph.getState(config)).metadata).toEqual(afterSnap.metadata);
  const finishedFromParent = parent?.tasks.map(({ name }) => name);
  if (mode === 'exit') expect(finishedFromParent).toBeUndefined();
  else {
    expect(finishedFromParent).toEqual(['prepare']);
    const parentConfig = afterTuple?.parentConfig;
    if (parentConfig === undefined) throw new Error('Missing retained parent checkpoint.');
    for (let i = 0; i < 10; i++)
      expect((await after.graph.getState(parentConfig)).tasks.map(({ name }) => name)).toEqual([
        'prepare',
      ]);
    expect(
      (await reopenedAfter.graph.getState(parentConfig)).tasks.map(({ name }) => name),
    ).toEqual(['prepare']);
  }
  record(
    'S2',
    {
      next: afterSnap.next,
      counts: after.counts,
      metadata: afterSnap.metadata,
      parentTasks: parent?.tasks.map(({ name }) => name),
      versionsSeen: afterTuple?.checkpoint.versions_seen,
      parentSourceStable: finishedFromParent !== undefined,
      versionsDifferenceSource: 'Not proven without a retained parent checkpoint.',
    },
    mode !== 'exit',
  );

  const baseline = setup('plain');
  const expected = await baseline.graph.invoke({}, config);
  const continued = await before.graph.invoke(null, config);
  expect(continued).toEqual(expected);
  expect(before.counts).toEqual({ prepare: 1, work: 1, finish: 1 });
  const commands = [];
  for (const resume of [false, true]) {
    const f = setup('before');
    await f.graph.invoke({}, config);
    let result: unknown;
    try {
      result = await f.graph.invoke(
        resume ? new Command({ resume: 'x' }) : new Command({}),
        config,
      );
    } catch (error) {
      result = { error: (error as Error).name };
    }
    commands.push({
      form: resume ? 'resume-without-interrupt' : 'empty-command',
      result,
      counts: f.counts,
    });
  }
  const transform = setup('before');
  await transform.graph.invoke({}, config);
  async function* source(): AsyncGenerator<null> {
    yield null;
  }
  for await (const _ of transform.graph.transform(source(), {
    ...config,
    streamMode: ['values', 'updates'],
  })) {
    /* Drain native transform. */
  }
  expect(transform.counts).toEqual({ prepare: 1, work: 1, finish: 1 });
  record('S3', { continued, counts: before.counts, commands, transformCounts: transform.counts });

  const loop = setup('loop');
  await loop.graph.invoke({}, config);
  const first = await loop.graph.getState(config);
  const identity = (s: typeof first) => ({
    checkpoint: s.config.configurable?.['checkpoint_id'],
    tasks: s.tasks.map(({ id, name }) => ({ id, name })),
    next: s.next,
  });
  for (let i = 0; i < 10; i++)
    expect(identity(await loop.graph.getState(config))).toEqual(identity(first));
  const reopened = createFixture('loop', reopenSaver(loop.saver, true));
  expect(identity(await reopened.graph.getState(config))).toEqual(identity(first));
  await loop.graph.invoke(null, config);
  const second = await loop.graph.getState(config);
  expect(second.config.configurable?.['checkpoint_id']).not.toBe(
    first.config.configurable?.['checkpoint_id'],
  );
  expect(second.next).toEqual(['work']);
  expect(loop.counts['work']).toBe(1);
  record('S4', { first: identity(first), second: identity(second), tenReadsAndReopenStable: true });
  await loop.graph.invoke(null, config);
  expect((await loop.graph.getState(config)).next).toEqual([]);
  expect(loop.counts['work']).toBe(2);
  record('S5', { counts: loop.counts, complete: true });

  for (const kind of ['fanoutOne', 'fanoutBoth'] as const) {
    const f = setup(kind);
    await f.graph.invoke({}, config);
    const s = await f.graph.getState(config);
    expect(s.next).toEqual(['a', 'b']);
    await f.graph.invoke(null, config);
    expect(f.counts).toEqual({ a: 1, b: 1 });
    record(`S6-${kind}`, {
      next: s.next,
      matching: s.next.filter((name) => f.graph.interruptBefore?.includes(name)),
      counts: f.counts,
    });
  }
  const wildcard = setup('wildcard');
  await wildcard.graph.invoke({}, config);
  expect((await wildcard.graph.getState(config)).next).toEqual(['prepare']);
  record('S7', {
    compiled: wildcard.graph.interruptBefore,
    next: ['prepare'],
    hiddenTagExclusion: 'Not measured.',
  });

  const mixed = setup('mixed');
  await mixed.graph.invoke({}, config);
  await mixed.graph.invoke(null, config);
  const dynamic = (await mixed.graph.getState(config)).tasks.flatMap((t) => t.interrupts)[0];
  expect(typeof dynamic?.id).toBe('string');
  await mixed.graph.invoke(
    new Command({ resume: { [dynamic?.id ?? '']: { action: 'continue', payload: null } } }),
    config,
  );
  expect(mixed.counts['work']).toBe(1);
  record('S8', { dynamic, counts: mixed.counts });

  const failing = setup('failing');
  await expect(failing.graph.invoke({}, config)).rejects.toThrow('Scripted failure.');
  const failed = await failing.graph.getState(config);
  expect(failed.next.length).toBeGreaterThan(0);
  expect(failed.tasks.some((t) => t.error !== undefined)).toBe(true);
  record('S9', { next: failed.next, hasTaskError: true });
  const child = setup('child');
  await child.graph.invoke({}, config);
  const childState = await child.graph.getState(config, { subgraphs: true });
  const nested = childState.tasks[0]?.state;
  await child.graph.invoke(null, config);
  expect(child.counts['work']).toBe(1);
  record(
    'S10',
    {
      parentNext: childState.next,
      childStateAvailable: nested !== undefined,
      nativeResumeCounts: child.counts,
      checkpointDiscovery:
        'Nested checkpoint identity not verified; executor refuses child pauses.',
    },
    false,
  );
  record('S11', {
    readableExitCheckpoint: snap.config.configurable?.['checkpoint_id'] !== undefined,
    nativeContinueTransformAndReopen: true,
  });
  const runtime = setup('plain');
  await runtime.graph.invoke({}, { ...config, interruptBefore: ['work'] });
  expect((await runtime.graph.getState(config)).next).toEqual(['work']);
  expect(runtime.graph.interruptBefore ?? []).toEqual([]);
  record(
    'S12',
    {
      next: ['work'],
      compiledBefore: runtime.graph.interruptBefore ?? [],
      runtimeOverrideInvisible: true,
    },
    false,
  );

  const ids: unknown[] = [];
  for (const kind of ['dynamic', 'send', 'dynamicChild'] as const) {
    const f = setup(kind);
    await f.graph.invoke({}, config);
    const s = await f.graph.getState(config, { subgraphs: true });
    const interrupts = s.tasks.flatMap((t) => t.interrupts);
    expect(interrupts.length).toBeGreaterThan(0);
    expect(interrupts.every((p) => typeof p.id === 'string')).toBe(true);
    ids.push({ kind, interrupts });
  }
  record('I1', { shapes: ids });
  for (const [probe, kind] of [
    ['I2', 'nodeInterrupt'],
    ['I3', 'rawInterrupt'],
  ] as const) {
    const f = setup(kind);
    await f.graph.invoke({}, config);
    const initial = (await f.graph.getState(config)).tasks.flatMap((t) => t.interrupts);
    expect(initial[0]?.id).toBeUndefined();
    await f.graph.invoke(new Command({ resume: 'x' }), config);
    const pending = (await f.graph.getState(config)).tasks.flatMap((t) => t.interrupts);
    expect(pending).toHaveLength(1);
    expect(f.counts['gate']).toBe(2);
    record(
      probe,
      { initial, pendingAfterResume: pending, executions: f.counts['gate'], advances: false },
      false,
    );
  }
  const stripped = setup('strippedNamespace');
  let error: string | undefined;
  try {
    await stripped.graph.invoke({}, config);
  } catch (e) {
    error = (e as Error).name;
  }
  const missing = (await stripped.graph.getState(config)).tasks.flatMap((t) => t.interrupts);
  expect(missing).toHaveLength(1);
  expect(missing[0]?.id).toBeUndefined();
  record('I4', {
    error,
    interrupts: missing,
    reachableWithoutId: true,
    producer: 'requestInteraction with stripped config',
  });
  const strippedSnap = await stripped.graph.getState(config);
  const taskId = strippedSnap.tasks[0]?.id;
  for (let i = 0; i < 10; i++)
    expect((await stripped.graph.getState(config)).tasks[0]?.id).toBe(taskId);
  expect(
    (
      await createFixture('strippedNamespace', reopenSaver(stripped.saver, true)).graph.getState(
        config,
      )
    ).tasks[0]?.id,
  ).toBe(taskId);
  record('I6', { taskId, committedResumeCount: 0, tenReadsAndReopenStable: true });
  const value = { action: 'continue', payload: null };
  const result = await stripped.graph.invoke(new Command({ resume: value }), config);
  expect(result.answer).toEqual(value);
  expect((await stripped.graph.getState(config)).next).toEqual([]);
  expect(stripped.counts['gate']).toBe(2);
  const parallel = setup('strippedSend');
  await parallel.graph.invoke({}, config);
  const parallelPauses = (await parallel.graph.getState(config)).tasks.flatMap((t) => t.interrupts);
  expect(parallelPauses).toHaveLength(2);
  expect(parallelPauses.every((p) => p.id === undefined)).toBe(true);
  const parallelResult = await parallel.graph.invoke(new Command({ resume: value }), config);
  expect(parallelResult.answer).toEqual(value);
  expect(parallelResult.trace).toEqual([
    `gate:${JSON.stringify(value)}`,
    `gate:${JSON.stringify(value)}`,
  ]);
  expect(parallel.counts['gate']).toBe(4);
  expect((await parallel.graph.getState(config)).next).toEqual([]);
  record('I5', {
    result,
    counts: stripped.counts,
    parallelBareResume: {
      pendingBefore: parallelPauses.length,
      result: parallelResult,
      counts: parallel.counts,
      bothTasksReceiveSameAnswer: true,
    },
  });
});
