// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import {
  createPythonFixture,
  type PythonFixture,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import existing from './cases-dspy/fixtures.json' with { type: 'json' };
import bound from './cases-dspy/state-bind-fixtures.json' with { type: 'json' };
import durable from './cases-dspy/state-durable-fixtures.json' with { type: 'json' };
import states from './cases-dspy/state-fixtures.json' with { type: 'json' };
import {
  type ParallelOrder,
  parallelAnswers,
  parallelLabels,
  parallelScenarios,
} from './support/dspy-parallel.js';
import {
  parallelGuardSources,
  parallelNativeReference,
  parallelSources,
} from './support/dspy-parallel-sources.node.js';
import { executeDspyParallelStep, type ParallelResult } from './support/dspy-parallel-step.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900000;
const stores = (): { checkpoints: MemoryByteCheckpoints; recovery: MemoryRecoveryStore } => ({
  checkpoints: new MemoryByteCheckpoints(),
  recovery: new MemoryRecoveryStore(),
});
const fixture = async (
  name: string,
  candidate = false,
  changed: boolean | 'removed' = false,
): Promise<PythonFixture> =>
  createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await parallelSources(name, candidate, changed),
  });
function clean(worker: PythonFixture): void {
  expect(worker.workerErrors).toEqual([]);
  expect(worker.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
}
function payloads(worker: PythonFixture): unknown[] {
  return worker.fromWorker
    .map((raw) => JSON.parse(raw) as { kind: string; op: string; payload: unknown })
    .filter((value) => value.kind === 'request' && value.op === 'model')
    .map((value) => value.payload);
}
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sorted(child)]),
      );
    return item;
  };
  return JSON.stringify(sorted(value));
}
function multiset(values: unknown[]): string[] {
  return values.map(canonical).sort();
}
function replayed(result: ParallelResult): unknown[] {
  return result.streams.filter((value) => (value as { kind: string }).kind === 'replayed');
}
function observe(name: string, lane: string, result: ParallelResult): void {
  expect(result.postTerminationRequests).toBe(0);
  console.info(
    JSON.stringify({
      scenario: name,
      lane,
      requests: result.modelLabels,
      completions: result.completions,
      writes: result.calls,
      crashed: result.crashed,
      postTerminationRequests: result.postTerminationRequests,
      output: result.output,
      error: result.error,
    }),
  );
}

// Run this first: actual threads starting would invalidate the single-thread design.
test(
  'Node Pyodide records the exact thread-start exception types',
  async () => {
    const worker = await fixture('par-verbatim-thread-start');
    try {
      const result = await executeDspyParallelStep(worker.options, worker.agent, stores(), {
        name: 'par-verbatim-thread-start',
      });
      observe('par-verbatim-thread-start', 'shipped', result);
      expect(result.output).toEqual({ thread: 'RuntimeError', pool: 'RuntimeError' });
      expect(result.error).toBeUndefined();
      expect(result.modelLabels).toEqual([]);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test.each(
  parallelScenarios.filter(
    (name) =>
      (name.startsWith('par-verbatim-') && name !== 'par-verbatim-thread-start') ||
      name.startsWith('par-refuse-'),
  ),
)(
  'Node Pyodide refuses verbatim fan-out and propagated contexts: %s',
  async (name) => {
    const worker = await fixture(name);
    try {
      const result = await executeDspyParallelStep(worker.options, worker.agent, stores(), {
        name,
      });
      observe(name, 'shipped', result);
      expect(result.error).toEqual({
        code: 'unsupported',
        message: 'This operation is unsupported.',
      });
      expect(result.modelLabels).toEqual([]);
      expect(result.calls).toEqual([]);
      expect(result.output).toBeUndefined();
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

const liveCases = ([false, true] as const).flatMap((candidate) => [
  { name: 'par-fan-single', order: 'forward' as ParallelOrder, candidate },
  { name: 'par-fan-single', order: 'reversed' as ParallelOrder, candidate },
  { name: 'par-fan-multi', order: 'reversed' as ParallelOrder, candidate },
  { name: 'par-fan-eval-loop', order: 'reversed' as ParallelOrder, candidate },
]);
test.each(liveCases)(
  'Node Pyodide live parity: $name $order candidate=$candidate',
  async ({ name, order, candidate }) => {
    const worker = await fixture(name, candidate);
    const store = stores();
    try {
      let result = await executeDspyParallelStep(worker.options, worker.agent, store, {
        name,
        order,
      });
      if (result.pending)
        result = await executeDspyParallelStep(worker.options, worker.agent, store, {
          name,
          order,
          sessionId: result.sessionId,
        });
      const reference = await parallelNativeReference(
        name === 'par-fan-multi' ? 'multi' : 'single',
        'before',
        name === 'par-fan-eval-loop',
      );
      observe(name, candidate ? 'candidate' : 'shipped', result);
      expect(result.error).toBeUndefined();
      expect(result.output).toEqual(reference.output);
      expect(multiset(payloads(worker))).toEqual(multiset(reference.payloads));
      expect(result.completions.slice(0, 3)).toEqual(
        (order === 'forward' ? parallelLabels : [...parallelLabels].reverse()).map(
          (label) => `${label}:before`,
        ),
      );
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test.each([false, true])(
  'Node Pyodide crash and reversed write re-dispatch candidate=%s',
  async (candidate) => {
    const name = 'par-fan-write';
    const worker = await fixture(name, candidate);
    const store = stores();
    try {
      const first = await executeDspyParallelStep(worker.options, worker.agent, store, { name });
      expect(first.pending).toBeDefined();
      const crash = await executeDspyParallelStep(worker.options, worker.agent, store, {
        name,
        sessionId: first.sessionId,
        crashAfterTwoWrites: true,
      });
      observe(name, `${candidate ? 'candidate' : 'shipped'}-crash`, crash);
      expect(crash.crashed).toBe(true);
      expect(crash.calls).toHaveLength(2);
      const restored = await executeDspyParallelStep(worker.options, worker.agent, store, {
        name,
        order: 'reversed',
        sessionId: first.sessionId,
      });
      observe(name, `${candidate ? 'candidate' : 'shipped'}-redispatch`, restored);
      expect(restored.error).toBeUndefined();
      expect(restored.output).toEqual({ answers: parallelAnswers('write') });
      expect([...crash.calls, ...restored.calls].sort()).toEqual(
        parallelLabels.map((label) => `${label}:before`).sort(),
      );
      expect(store.recovery.journal.size).toBe(3);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

const replayCases = ([false, true] as const).flatMap((candidate) =>
  ['single', 'multi'].map((shape) => ({
    candidate,
    shape: shape as 'single' | 'multi',
    name: `par-fan-two-stage-${shape}`,
  })),
);
test.each(replayCases)(
  'Node Pyodide fresh-Worker replay: $name candidate=$candidate',
  async ({ candidate, shape, name }) => {
    const worker = await fixture(name, candidate);
    const store = stores();
    try {
      const first = await executeDspyParallelStep(worker.options, worker.agent, store, { name });
      expect(first.pending).toBeDefined();
      const beforePayloads = payloads(worker).length;
      const restored = await executeDspyParallelStep(worker.options, worker.agent, store, {
        name,
        order: 'reversed',
        sessionId: first.sessionId,
      });
      observe(name, candidate ? 'candidate' : 'shipped', restored);
      if (candidate || shape === 'single') {
        expect(restored.error).toBeUndefined();
        expect(restored.output).toEqual({
          before: parallelAnswers(shape),
          answers: parallelAnswers(shape, 'after'),
        });
        expect(
          restored.modelLabels.every(
            (question) => question.endsWith(':after') || question.endsWith(':last-after'),
          ),
        ).toBe(true);
        expect(restored.modelLabels).toHaveLength(shape === 'single' ? 3 : 6);
        expect(replayed(restored)).toHaveLength(1);
        const reference = await parallelNativeReference(shape, 'after');
        expect(multiset(payloads(worker).slice(beforePayloads))).toEqual(
          multiset(reference.payloads),
        );
      } else {
        expect(restored.error).toEqual({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
        expect(restored.modelLabels).toEqual([]);
        expect(restored.calls).toEqual([]);
      }
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test.each([false, true])(
  'Node Pyodide eval-loop restores without replayed dispatch candidate=%s',
  async (candidate) => {
    const name = 'par-fan-eval-loop';
    const worker = await fixture(name, candidate);
    const store = stores();
    try {
      const first = await executeDspyParallelStep(worker.options, worker.agent, store, {
        name,
        question: 'reload',
      });
      expect(first.pending).toBeDefined();
      const restored = await executeDspyParallelStep(worker.options, worker.agent, store, {
        name,
        order: 'reversed',
        sessionId: first.sessionId,
      });
      observe(name, `${candidate ? 'candidate' : 'shipped'}-replay`, restored);
      expect(restored.error).toBeUndefined();
      expect(restored.output).toEqual(
        (await parallelNativeReference('single', 'before', true)).output,
      );
      expect(restored.modelLabels).toEqual([]);
      expect(replayed(restored)).toHaveLength(1);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

const divergenceCases = ([false, true] as const).flatMap((candidate) =>
  ([true, 'removed'] as const).map((changed) => ({ candidate, changed })),
);
test.each(divergenceCases)(
  'Node Pyodide divergence precedes live work candidate=$candidate changed=$changed',
  async ({ candidate, changed }) => {
    const name = 'par-fan-diverge';
    const firstWorker = await fixture(name, candidate);
    const store = stores();
    let secondWorker: PythonFixture | undefined;
    try {
      const first = await executeDspyParallelStep(firstWorker.options, firstWorker.agent, store, {
        name,
      });
      expect(first.pending).toBeDefined();
      secondWorker = await fixture(name, candidate, changed);
      const restored = await executeDspyParallelStep(
        secondWorker.options,
        secondWorker.agent,
        store,
        { name, sessionId: first.sessionId },
      );
      observe(name, `${candidate ? 'candidate' : 'shipped'}-${changed}`, restored);
      expect(restored.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(restored.modelLabels).toEqual([]);
      expect(restored.calls).toEqual([]);
      clean(firstWorker);
      clean(secondWorker);
    } finally {
      await secondWorker?.cleanup();
      await firstWorker.cleanup();
    }
  },
  timeout,
);

test.each(
  ([false, true] as const).flatMap((candidate) =>
    ['par-fan-pause-in-branch', 'par-fan-concurrent-pauses'].map((name) => ({ candidate, name })),
  ),
)(
  'Node Pyodide branch pause is fixed refused $name candidate=$candidate',
  async ({ candidate, name }) => {
    const worker = await fixture(name, candidate);
    try {
      const result = await executeDspyParallelStep(worker.options, worker.agent, stores(), {
        name,
      });
      observe(name, candidate ? 'candidate' : 'shipped', result);
      expect(result.error).toEqual({
        code: 'unsupported',
        message: 'This operation is unsupported.',
      });
      expect(result.pending).toBeUndefined();
      expect(result.modelLabels.length).toBeLessThanOrEqual(1);
      expect(result.calls).toEqual([]);
      expect(result.streams).toContainEqual({
        kind: 'spike-tasks',
        count: candidate || name === 'par-fan-concurrent-pauses' ? 0 : 1,
      });
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'Node Pyodide candidate group guards are fixed and leave no tasks',
  async () => {
    const worker = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await parallelGuardSources(),
    });
    try {
      const result = await executeDspyParallelStep(worker.options, worker.agent, stores(), {
        name: 'guards',
      });
      const expected = Object.fromEntries(
        ['invalid', 'duplicate', 'wide', 'nested', 'streaming'].flatMap((name) => [
          [name, 'unsupported'],
          [`${name}_tasks`, 0],
        ]),
      );
      expect(result.output).toEqual(expected);
      expect(result.error).toBeUndefined();
      expect(result.modelLabels).toEqual([]);
      expect(result.calls).toEqual([]);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'parallel probes form a separate fixture family',
  () => {
    const names = [
      ...Object.keys(existing),
      ...Object.keys(states),
      ...durable.scenarios.map((scenario) => scenario.name),
      ...bound.scenarios.map((scenario) => scenario.name),
    ];
    expect(new Set(parallelScenarios).size).toBe(parallelScenarios.length);
    expect(parallelScenarios.filter((name) => names.includes(name))).toEqual([]);
  },
  timeout,
);
