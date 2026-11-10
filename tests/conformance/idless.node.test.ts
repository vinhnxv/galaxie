// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { IDLESS_CASE_NAMES, idlessCases } from './cases/idless.js';
import { normalize } from './support/normalize.js';
import { runNative } from './support/transcript.js';

test.each(IDLESS_CASE_NAMES)('native %s matches its golden', async (name) => {
  const native = await import('@langchain/langgraph');
  const transcript = await runNative(idlessCases[name], native);
  expect(transcript.outcome).toEqual({ status: 'succeeded' });
  expect(transcript.pauses).toHaveLength(name === 'idless-submit' ? 1 : 2);
  expect(transcript.state.next).toEqual([]);
  expect(transcript.final).toMatchObject({
    answer: { action: 'submit', payload: { answer: 'yes' } },
    applications: name === 'idless-submit' ? 1 : 2,
    counts: { prepare: 1, gate: 2, second: name === 'idless-submit' ? 0 : 2 },
  });
  await expect(`${JSON.stringify(normalize(transcript), null, 2)}\n`).toMatchFileSnapshot(
    `./golden/${name}.json`,
  );
});

test('native ID-less shapes record bare-resume behavior and the galaxie outcome', async () => {
  const native = await import('@langchain/langgraph');
  const { IDLESS_SHAPES, shapeGraph, expectedOutcome } = await import('./cases/idless-shapes.js');
  const evidence: Record<string, unknown> = {};
  for (const shape of IDLESS_SHAPES) {
    const saver = new native.MemorySaver();
    const { graph, counts } = shapeGraph(native, saver, shape, {
      request: (value) => native.interrupt(value),
    });
    const config = { configurable: { thread_id: crypto.randomUUID() } };
    await graph.invoke({}, config);
    const before = await graph.getState(config);
    const tasks = before.tasks.filter((task) => task.interrupts.length > 0);
    const interrupts = tasks.flatMap((task) => task.interrupts);
    const beforeCounts = { ...counts };
    await graph.invoke(
      new native.Command({ resume: { action: 'submit', payload: { answer: 'yes' } } }),
      config,
    );
    const after = await graph.getState(config);
    evidence[shape] = {
      native: {
        interruptIdsPresent: interrupts.map(({ id }) => id !== undefined),
        interruptingTasks: tasks.length,
        childNamespace: tasks.some((task) => task.state !== undefined),
        beforeCounts,
        afterCounts: { ...counts },
        applications: after.values.applications,
        answers: after.values.answers,
        pendingAfterAnswer: after.tasks.flatMap((task) => task.interrupts).length,
      },
      galaxie: expectedOutcome(shape),
    };
    if (shape === 'parallelSend') expect(after.values.applications).toBe(2);
    if (shape.startsWith('bodyChild')) {
      expect(after.values.applications).toBe(1);
      expect(counts).toEqual({ parent: 2, gate: 2, effects: 1 });
    }
  }
  await expect(`${JSON.stringify(evidence, null, 2)}\n`).toMatchFileSnapshot(
    './golden/idless-shapes.json',
  );
});
