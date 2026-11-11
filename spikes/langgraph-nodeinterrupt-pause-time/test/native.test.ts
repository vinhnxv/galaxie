// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { parseInteractionRequest, toErrorInfo } from '@galaxie-ai/core';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import {
  Command,
  GraphInterrupt,
  isGraphInterrupt,
  MemorySaver,
  NodeInterrupt,
} from '@langchain/langgraph';
import { afterAll, expect, test } from 'vitest';
import {
  type Candidate,
  candidateHelper,
  classifies,
  mark,
  marked,
  RESPONSE_SCHEMA,
  VALUE_MARKER,
} from '../src/candidates.js';
import { reopenSaver } from '../src/checkpoint-reader.js';
import {
  answer,
  createFixture,
  DURABILITIES,
  type Durability,
  type Helper,
  question,
  type Shape,
} from '../src/graphs.js';
import { Observer } from '../src/observer.js';
import { normalize, type Observation, writeEvidence } from './evidence.js';
import { protocolProbe } from './protocol.js';

const observations: Observation[] = [];
afterAll(() => writeEvidence(observations));

async function pause(shape: Shape, mode: Durability, helper?: Helper, thrown?: () => never) {
  const saver = new MemorySaver();
  const fixture = createFixture(shape, saver, helper, thrown);
  const config = { configurable: { thread_id: `spike-${mode}` }, durability: mode };
  const observer = new Observer();
  const chunks: unknown[] = [];
  for await (const chunk of await fixture.graph.stream(
    {},
    {
      ...config,
      streamMode: 'updates',
      callbacks: [observer],
    },
  ))
    chunks.push(chunk);
  const snapshot = await fixture.graph.getState(config);
  const tuple = await saver.getTuple(config);
  const reopenedSaver = reopenSaver(saver, true);
  const reopened = createFixture(shape, reopenedSaver);
  const restored = await reopened.graph.getState(config);
  return {
    ...fixture,
    saver,
    config,
    observer,
    chunks,
    snapshot,
    tuple,
    reopened,
    reopenedSaver,
    restored,
    surfaces: normalize({
      chunks,
      observer: observer.records(chunks),
      tasks: snapshot.tasks,
      pendingWrites: tuple?.pendingWrites,
      reopenedTasks: restored.tasks,
      reversedWrites: (await reopenedSaver.getTuple(config))?.pendingWrites,
    }),
  };
}

test.each(DURABILITIES)('baseline surfaces (%s)', async (mode) => {
  const record = (probe: string, observation: unknown, pass = true): void => {
    observations.push({ probe, mode, pass, observation: normalize(observation) });
  };
  const helper = await pause('helperIdless', mode);
  expect(helper.snapshot.tasks[0]?.interrupts[0]?.id).toBeUndefined();
  expect(helper.snapshot.tasks).toHaveLength(1);
  expect(helper.counts).toEqual({ gate: 1, effects: 0 });
  record('P1', helper.surfaces);
  const comparisons = [];
  for (const [probe, shape] of [
    ['P2', 'nodeInterruptRequest'],
    ['P3', 'rawGraphInterrupt'],
    ['P4', 'rawInterruptCall'],
  ] as const) {
    const f = await pause(shape, mode);
    expect(f.snapshot.tasks[0]?.interrupts[0]?.id).toBeUndefined();
    expect(f.counts).toEqual({ gate: 1, effects: 0 });
    record(probe, f.surfaces);
    const comparison = {
      shape,
      surfaces: Object.fromEntries(
        Object.entries(f.surfaces as Record<string, unknown>).map(([surface, value]) => [
          surface,
          JSON.stringify(value) ===
          JSON.stringify((helper.surfaces as Record<string, unknown>)[surface])
            ? 'identical'
            : 'differs',
        ]),
      ),
    };
    expect(comparison.surfaces['chunks']).toBe('identical');
    expect(comparison.surfaces['tasks']).toBe('identical');
    expect(comparison.surfaces['pendingWrites']).toBe('identical');
    expect(comparison.surfaces['reopenedTasks']).toBe('identical');
    comparisons.push(comparison);
  }
  record(
    'P6',
    comparisons,
    comparisons.every((row) => row.surfaces['reopenedTasks'] === 'differs'),
  );
});

test.each(DURABILITIES)('candidate discriminators (%s)', async (mode) => {
  const record = (probe: string, observation: unknown, pass = true): void => {
    observations.push({ probe, mode, pass, observation: normalize(observation) });
  };
  const baseline = await pause('helperIdless', mode);
  const bare = await pause('rawInterruptCall', mode);
  const node = await pause('nodeInterruptRequest', mode);
  const raw = await pause('rawGraphInterrupt', mode);
  const fixture = async (candidate: Candidate, shape: Shape = 'helperIdless') =>
    pause(shape, mode, (value, config) => candidateHelper(candidate, value, config));
  const pending = (f: Awaited<ReturnType<typeof pause>>) => f.snapshot.tasks[0]?.interrupts[0];
  const resumes = async (f: Awaited<ReturnType<typeof pause>>) => {
    const id = pending(f)?.id;
    const output = await f.graph.invoke(
      new Command({ resume: id === undefined ? answer : { [id]: answer } }),
      f.config,
    );
    expect(output).toEqual({ answer });
    expect(f.counts).toEqual({ gate: 2, effects: 1 });
    expect((await f.graph.getState(f.config)).next).toEqual([]);
    return { output, counts: { ...f.counts } };
  };

  const candidates = new Map<Candidate, Awaited<ReturnType<typeof pause>>>();
  for (const [probe, candidate] of [
    ['P7', 'D1'],
    ['P8', 'D2'],
    ['P9', 'D3'],
  ] as const) {
    const f = await fixture(candidate);
    candidates.set(candidate, f);
    const live = classifies(candidate, pending(f), f.observer.errors);
    const persisted = classifies(candidate, f.restored.tasks[0]?.interrupts[0]);
    const strictValue = parseInteractionRequest(pending(f)?.value) !== undefined;
    const streamMatchesBare =
      JSON.stringify(normalize(f.chunks)) === JSON.stringify(normalize(bare.chunks));
    expect(live).toBe(true);
    expect(persisted).toBe(candidate !== 'D3');
    expect(strictValue).toBe(candidate !== 'D1');
    expect(streamMatchesBare).toBe(candidate === 'D3');
    if (candidate === 'D2') expect(toJsonSchema(RESPONSE_SCHEMA)).toEqual(RESPONSE_SCHEMA);
    const resumed = await resumes(f);
    record(
      probe,
      {
        candidate,
        surfaces: f.surfaces,
        live,
        persisted,
        strictValue,
        streamMatchesBare,
        observerMarks: f.observer.errors.map(marked),
        snapshotMark: marked(pending(f)),
        uniqueObservedInterrupts: new Set(
          f.observer.errors.flatMap((error) => (isGraphInterrupt(error) ? error.interrupts : [])),
        ).size,
        interruptingRootTasks: f.snapshot.tasks.filter((task) => task.interrupts.length > 0).length,
        ...(candidate === 'D2'
          ? {
              plainSchemaResume: {
                declaredType: RESPONSE_SCHEMA.type,
                returnedType: typeof resumed.output.answer,
              },
            }
          : {}),
        resumed,
      },
      live && persisted && strictValue && streamMatchesBare,
    );
  }

  const errorShape = {
    helper: baseline.observer.records(baseline.chunks),
    node: node.observer.records(node.chunks),
    raw: raw.observer.records(raw.chunks),
    liveHelper: classifies('D4', pending(baseline), baseline.observer.errors),
    liveNode: classifies('D4', pending(node), node.observer.errors),
    liveRaw: classifies('D4', pending(raw), raw.observer.errors),
    restoredHelper: classifies('D4', baseline.restored.tasks[0]?.interrupts[0]),
    privateShapeDependency:
      'The own undefined id key and error name are construction details, not a persisted helper-origin contract.',
  };
  expect(errorShape).toMatchObject({
    liveHelper: true,
    liveNode: false,
    liveRaw: false,
    restoredHelper: false,
  });
  record('P10', errorShape, errorShape.restoredHelper);

  const forged = [];
  for (const candidate of ['D1', 'D2', 'D3'] as const) {
    for (const shape of ['nodeInterruptRequest', 'rawGraphInterrupt'] as const) {
      const thrown = (): never => {
        const value = candidate === 'D1' ? { ...question, __galaxie: VALUE_MARKER } : question;
        const error =
          shape === 'nodeInterruptRequest'
            ? new NodeInterrupt(value)
            : new GraphInterrupt([{ value }]);
        if (candidate === 'D2')
          Object.assign(error.interrupts[0] as object, { response_schema: RESPONSE_SCHEMA });
        if (candidate === 'D3') mark(error);
        throw error;
      };
      const f = await pause(shape, mode, undefined, thrown);
      expect(classifies(candidate, pending(f), f.observer.errors)).toBe(true);
      await f.graph.invoke(new Command({ resume: answer }), f.config);
      expect((await f.graph.getState(f.config)).tasks[0]?.interrupts).toHaveLength(1);
      expect(f.counts.effects).toBe(0);
      const protocol = await protocolProbe(shape, mode, candidate, thrown);
      expect(protocol.live).toMatchObject({
        published: candidate === 'D1' ? 0 : 1,
        status: 'failed',
        error: toErrorInfo('unsupported'),
        counts: { gate: candidate === 'D1' ? 1 : 2, effects: 0 },
        inbox: candidate === 'D1' ? [] : ['accepted'],
      });
      expect(protocol.restored.counts.effects).toBe(0);
      expect(protocol.restored.inbox).toEqual(candidate === 'D1' ? [] : ['accepted']);
      forged.push({ candidate, shape, nativeCounts: f.counts, protocol });
    }
  }
  record(
    'P11',
    {
      forged,
      scope:
        'Native graph and a narrow spike-local protocol witness through unmodified core; D1 fails the required one-publication behavior.',
    },
    false,
  );

  const replacement = await pause('helperIdBearing', mode);
  const id = pending(replacement)?.id;
  expect(typeof id).toBe('string');
  expect(replacement.restored.tasks[0]?.interrupts[0]).toEqual(pending(replacement));
  const liveResult = await resumes(replacement);
  const restoredOutput = await replacement.reopened.graph.invoke(
    new Command({ resume: { [id as string]: answer } }),
    replacement.config,
  );
  expect(restoredOutput).toEqual({ answer });
  expect(replacement.reopened.counts).toEqual({ gate: 1, effects: 1 });
  const replacementProtocol = await protocolProbe('helperIdBearing', mode);
  expect(replacementProtocol.live).toMatchObject({
    published: 1,
    status: 'succeeded',
    counts: { gate: 2, effects: 1 },
    inbox: ['consumed'],
  });
  expect(replacementProtocol.restored).toMatchObject({
    status: 'succeeded',
    counts: { gate: 1, effects: 1 },
    inbox: ['consumed'],
  });
  record('P12', {
    idBearing: true,
    request: pending(replacement)?.value,
    liveResult,
    restoredOutput,
    restoredCounts: replacement.reopened.counts,
    samePauseAfterReopen: true,
    protocol: replacementProtocol,
  });

  const reopenedMarkers = [];
  for (const candidate of ['D1', 'D2'] as const) {
    const f = candidates.get(candidate);
    if (f === undefined) throw new Error('Missing candidate observation.');
    const reversed = classifies(candidate, f.restored.tasks[0]?.interrupts[0]);
    const originalSaver = f.reopenedSaver;
    const tuple = await originalSaver.getTuple(f.config);
    const inOrderPaused = createFixture('helperIdless', reopenSaver(originalSaver)).graph;
    const inOrder = classifies(
      candidate,
      (await inOrderPaused.getState(f.config)).tasks[0]?.interrupts[0],
    );
    expect(reversed).toBe(true);
    expect(inOrder).toBe(true);
    reopenedMarkers.push({ candidate, inOrder, reversed, pendingWrites: tuple?.pendingWrites });
  }
  record('P13', reopenedMarkers);

  const narrowing = [];
  for (const candidate of ['D1', 'D2', 'D3', 'D4'] as const) {
    const bearing = await fixture(candidate, 'helperIdBearing');
    expect(normalize(bearing.chunks)).toEqual(normalize(replacement.chunks));
    const bearingResume = await resumes(bearing);
    const rejectsBare = !classifies(candidate, pending(bare), bare.observer.errors);
    const rejectsExistingHelperCheckpoint = !classifies(
      candidate,
      baseline.restored.tasks[0]?.interrupts[0],
    );
    expect(rejectsExistingHelperCheckpoint).toBe(true);
    narrowing.push({
      candidate,
      rawIdlessInterrupt: rejectsBare
        ? 'refused (undocumented fallback; accepted trade-off)'
        : 'preserved live; refused on restore',
      existingUnmarkedHelperCheckpoint: 'refused (documented restore shape; fails criterion)',
      idBearing: 'unchanged',
      bearingResume,
    });
  }
  record('P14', narrowing, false);

  const verdicts = [];
  for (const candidate of ['D1', 'D2', 'D3', 'D4'] as const) {
    const f = candidates.get(candidate) ?? baseline;
    const C1 =
      classifies(candidate, pending(f), f.observer.errors) &&
      classifies(candidate, f.restored.tasks[0]?.interrupts[0]);
    const C2 =
      !classifies(candidate, pending(node), node.observer.errors) &&
      !classifies(candidate, pending(raw), raw.observer.errors);
    const C4 =
      candidate !== 'D1' &&
      JSON.stringify(normalize(f.chunks)) === JSON.stringify(normalize(bare.chunks));
    const criteria = {
      C1: { pass: C1, evidence: candidate === 'D4' ? 'P10' : 'P7/P8/P9/P13' },
      C2: { pass: C2, evidence: 'P2/P3; unmarked thrown requests' },
      C3: {
        pass: candidate === 'D2' || candidate === 'D3',
        status: candidate === 'D4' ? 'unmeasured' : candidate === 'D1' ? 'fail' : 'pass',
        evidence:
          'P11: actual publication, first-answer failure, no applied answer, retained inbox through unmodified core',
      },
      C4: { pass: C4, evidence: 'P7/P8/P9 vs P4; P14 ID-bearing control' },
      C5: {
        pass: true,
        evidence:
          'Constant markers, observer records name/keys/booleans only, fixed unsupported refusal; no spans or logs added',
      },
      C6: {
        pass: candidate !== 'D4',
        evidence:
          candidate === 'D4'
            ? 'P10: private construction heuristic'
            : 'Public interrupt/responseSchema/error APIs at locked 1.5.1 and 1.2.20; other peer patch versions unmeasured',
      },
      C7: {
        pass: false,
        evidence: 'P14: existing documented unmarked helper checkpoint would be refused',
      },
    };
    verdicts.push({
      candidate,
      criteria,
      pass: Object.values(criteria).every((criterion) => criterion.pass),
    });
  }
  expect(verdicts.every((row) => !row.pass)).toBe(true);
  record(
    'criteria',
    verdicts,
    verdicts.some((row) => row.pass),
  );
});
