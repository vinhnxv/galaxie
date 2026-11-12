// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { branchGuardSources, branchSources } from './support/dspy-branches-sources.node.js';
import { parallelAnswers } from './support/dspy-parallel.js';
import { executeDspyParallelStep, type ParallelResult } from './support/dspy-parallel-step.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test.each([
  true,
  'removed',
  'renamed',
  'fewer',
  'extra',
  'extra-key-first',
  'extra-key-last',
] as const)(
  'shipped branch divergence poisons once and later restore adds nothing: %s',
  async (changed) => {
    const name = 'par-fan-diverge';
    const firstWorker = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executeDspyParallelStep(firstWorker.options, firstWorker.agent, store, {
        name,
      });
      expect(first.pending).toBeDefined();
      const rows = structuredClone(store.checkpoints.rows);
      const writes = structuredClone(store.checkpoints.writes);
      const secondWorker = await createPythonFixture({
        framework: 'dspy',
        module: 'selected',
        sources: await branchSources(name, changed),
      });
      try {
        const restored = await executeDspyParallelStep(
          secondWorker.options,
          secondWorker.agent,
          store,
          { name, sessionId: first.sessionId },
        );
        expect(restored.error).toEqual({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
        expect(restored.modelLabels).toEqual([]);
        expect(restored.calls).toEqual([]);
        expect(restored.postTerminationRequests).toBe(0);
        for (const [key, row] of rows) expect(store.checkpoints.rows.get(key)).toEqual(row);
        for (const [key, value] of writes) expect(store.checkpoints.writes.get(key)).toEqual(value);
        const added = [...store.checkpoints.rows].filter(([key]) => !rows.has(key));
        expect(added).toHaveLength(1);
        const marker = added[0]?.[1];
        expect(marker).toBeDefined();
        const previousId = [...rows.values()]
          .map((row) => row.id)
          .sort()
          .at(-1);
        expect(marker?.parentId).toBe(previousId);
        expect(marker?.id).toBe((BigInt(previousId ?? '0') + 1n).toString().padStart(20, '0'));
        expect(JSON.parse(new TextDecoder().decode(marker?.checkpoint.bytes))).toMatchObject({
          status: 'unrecoverable',
          input: null,
          journal: [],
        });
        expect(
          Object.keys(JSON.parse(new TextDecoder().decode(marker?.metadata.bytes))).sort(),
        ).toEqual(['adapter', 'dspy', 'session', 'v']);
        const markerWrites = store.checkpoints.writes.get(added[0]?.[0] ?? '');
        expect(markerWrites).toHaveLength(1);
        expect(markerWrites?.[0]).toMatchObject({
          channel: '__interrupt__',
          index: -3,
          value: { type: 'json' },
        });
        expect(JSON.parse(new TextDecoder().decode(markerWrites?.[0]?.value.bytes))).toBeNull();
        const poisonedRows = structuredClone(store.checkpoints.rows);
        const poisonedWrites = structuredClone(store.checkpoints.writes);
        const thirdWorker = await createPythonFixture({
          framework: 'dspy',
          module: 'selected',
          sources: await branchSources(name),
        });
        try {
          const poisoned = await executeDspyParallelStep(
            thirdWorker.options,
            thirdWorker.agent,
            store,
            { name, sessionId: first.sessionId },
          );
          expect(poisoned.error).toEqual({
            code: 'unrecoverable',
            message: 'Stored state cannot be recovered.',
          });
          expect(poisoned.modelLabels).toEqual([]);
          expect(poisoned.calls).toEqual([]);
          expect(poisoned.postTerminationRequests).toBe(0);
          expect(store.checkpoints.rows).toEqual(poisonedRows);
          expect(store.checkpoints.writes).toEqual(poisonedWrites);
          expect(thirdWorker.workerErrors).toEqual([]);
        } finally {
          await thirdWorker.cleanup();
        }
        expect(firstWorker.workerErrors).toEqual([]);
        expect(secondWorker.workerErrors).toEqual([]);
      } finally {
        await secondWorker.cleanup();
      }
    } finally {
      await firstWorker.cleanup();
    }
  },
  900000,
);

for (const shape of ['single', 'multi'] as const) {
  test(`shipped ${shape} replays only recorded groups across a fresh Worker`, async () => {
    const name = `par-fan-two-stage-${shape}`;
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const first = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    let paused: ParallelResult;
    try {
      paused = await executeDspyParallelStep(first.options, first.agent, store, { name });
      expect(paused.pending).toBeDefined();
      expect(first.workerErrors).toEqual([]);
    } finally {
      await first.cleanup();
    }
    const second = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    try {
      const resumed = await executeDspyParallelStep(second.options, second.agent, store, {
        name,
        order: 'reversed',
        sessionId: paused.sessionId,
      });
      expect(resumed.error).toBeUndefined();
      expect(resumed.restored).toEqual(paused.pending);
      expect(resumed.output).toEqual({
        before: parallelAnswers(shape),
        answers: parallelAnswers(shape, 'after'),
      });
      expect(resumed.modelLabels).toHaveLength(shape === 'multi' ? 6 : 3);
      expect(resumed.modelLabels.every((label) => /:(?:last-)?after$/.test(label))).toBe(true);
      expect(resumed.calls.every((label) => label.endsWith(':after'))).toBe(true);
      expect(
        resumed.streams.filter((value) => (value as { kind?: string }).kind === 'replayed'),
      ).toHaveLength(1);
      expect(resumed.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
      expect(resumed.postTerminationRequests).toBe(0);
      expect(second.workerErrors).toEqual([]);
    } finally {
      await second.cleanup();
    }
  }, 900000);
}

test('shipped evaluation-loop replay dispatches zero requests', async () => {
  const name = 'par-fan-eval-loop';
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  let sessionId = '';
  for (const resume of [false, true]) {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    try {
      const result = await executeDspyParallelStep(fixture.options, fixture.agent, store, {
        name,
        question: 'reload',
        ...(resume ? { sessionId } : {}),
      });
      sessionId = result.sessionId;
      expect(result.error).toBeUndefined();
      expect(result.modelLabels).toHaveLength(resume ? 0 : 4);
      expect(result.calls).toEqual([]);
      if (resume) {
        expect(result.output).toEqual({
          answers: ['alpha:before', 'beta:before', 'gamma:before', 'delta:before'],
          score: 100,
        });
        expect(
          result.streams.filter((value) => (value as { kind?: string }).kind === 'replayed'),
        ).toHaveLength(1);
      } else expect(result.pending).toBeDefined();
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }
}, 900000);

test('shipped receipt scopes and checkpoint bytes ignore model arrival order', async () => {
  const records = [];
  for (const order of ['forward', 'reversed'] as const) {
    const name = 'par-fan-two-stage-multi';
    const sources = await branchSources(name);
    sources['selected.py'] +=
      "\nimport uuid\nuuid.uuid4 = lambda: uuid.UUID('55de87eb-28d7-466f-9222-de0713ae5d68')\n";
    const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const result = await executeDspyParallelStep(fixture.options, fixture.agent, store, {
        name,
        order,
      });
      expect(result.pending).toBeDefined();
      const row = [...store.checkpoints.rows.values()].at(-1);
      const checkpoint = JSON.parse(new TextDecoder().decode(row?.checkpoint.bytes));
      expect(checkpoint.journal.slice(0, -1)).toHaveLength(9);
      expect(
        checkpoint.journal
          .slice(0, -1)
          .every(
            (entry: { fanout?: string; result?: unknown }) =>
              entry.fanout && entry.result !== undefined,
          ),
      ).toBe(true);
      const scopes = fixture.fromWorker
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.kind === 'request' && message.op === 'capability')
        .map((message) => ({
          query: message.payload.input.query,
          scope: message.payload.effectScope,
        }))
        .sort((a, b) => a.query.localeCompare(b.query));
      expect(scopes).toEqual(
        ['alpha', 'beta', 'gamma'].map((key) => ({
          query: `${key}:before`,
          scope: `dspy/55de87eb-28d7-466f-9222-de0713ae5d68/1/0/before.${key}/1`,
        })),
      );
      // Session identity belongs to core; checkpoint bytes and branch effect IDs do not.
      records.push({
        bytes: row?.checkpoint.bytes,
        effects: [...store.recovery.journal.values()].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      });
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }
  expect(records[0]).toEqual(records[1]);
}, 900000);

test.each(['par-fan-write', 'par-fan-multi'])(
  'shipped helper deduplicates two receipts after Worker loss: %s',
  async (name) => {
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    let sessionId = '';
    const calls: string[] = [];
    for (const stage of ['pause', 'crash', 'resume'] as const) {
      const fixture = await createPythonFixture({
        framework: 'dspy',
        module: 'selected',
        sources: await branchSources(name),
      });
      try {
        const result = await executeDspyParallelStep(fixture.options, fixture.agent, store, {
          name,
          ...(stage === 'pause' ? {} : { sessionId }),
          ...(stage === 'crash' ? { crashAfterTwoWrites: true } : {}),
          order: stage === 'resume' ? 'reversed' : 'forward',
        });
        sessionId = result.sessionId;
        calls.push(...result.calls);
        if (stage === 'pause') expect(result.pending).toBeDefined();
        if (stage === 'crash') expect(result.crashed).toBe(true);
        if (stage === 'resume') {
          expect(result.error).toBeUndefined();
          expect(result.output).toEqual({
            answers: parallelAnswers(name === 'par-fan-write' ? 'write' : 'multi'),
          });
        }
        expect(fixture.workerErrors).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }
    expect(calls.sort()).toEqual(['alpha:before', 'beta:before', 'gamma:before']);
  },
  900000,
);

test.each(['marker', 'unknown'])(
  'shipped restore refuses invalid %s before adding a row',
  async (fault) => {
    const name = 'par-fan-diverge';
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const first = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    let sessionId = '';
    try {
      sessionId = (await executeDspyParallelStep(first.options, first.agent, store, { name }))
        .sessionId;
    } finally {
      await first.cleanup();
    }
    const row = [...store.checkpoints.rows.values()].at(-1);
    if (!row) throw new Error('The checkpoint is absent.');
    const checkpoint = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
    if (fault === 'marker') checkpoint.journal[0].fanout = '00/alpha/0';
    else checkpoint.journal[0].unknown = true;
    const rowKey = [...store.checkpoints.rows.keys()].at(-1);
    if (!rowKey) throw new Error('The checkpoint key is absent.');
    store.checkpoints.rows.set(rowKey, {
      ...row,
      checkpoint: {
        ...row.checkpoint,
        bytes: new TextEncoder().encode(JSON.stringify(checkpoint)),
      },
    });
    const rows = structuredClone(store.checkpoints.rows),
      writes = structuredClone(store.checkpoints.writes);
    const second = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    try {
      const result = await executeDspyParallelStep(second.options, second.agent, store, {
        name,
        sessionId,
      });
      expect(result.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(result.calls).toEqual([]);
      expect(result.modelLabels).toEqual([]);
      expect(store.checkpoints.rows).toEqual(rows);
      expect(store.checkpoints.writes).toEqual(writes);
      expect(second.workerErrors).toEqual([]);
    } finally {
      await second.cleanup();
    }
  },
  900000,
);

test('shipped helper keeps nested, wide and streaming refusals with no tasks', async () => {
  const fixture = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await branchGuardSources(),
  });
  try {
    const result = await executeDspyParallelStep(
      fixture.options,
      fixture.agent,
      { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() },
      { name: 'par-fan-single' },
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual(
      Object.fromEntries(
        ['invalid', 'duplicate', 'wide', 'nested', 'streaming'].flatMap((shape) => [
          [shape, 'unsupported'],
          [shape + '_tasks', 0],
        ]),
      ),
    );
    expect(result.modelLabels).toEqual([]);
    expect(fixture.workerErrors).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
}, 900000);

test.each(['par-fan-pause-in-branch', 'par-fan-concurrent-pauses'])(
  'shipped branch interaction is refused and drained: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await branchSources(name),
    });
    try {
      const result = await executeDspyParallelStep(
        fixture.options,
        fixture.agent,
        { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() },
        { name },
      );
      expect(result.error).toEqual({
        code: 'unsupported',
        message: 'This operation is unsupported.',
      });
      expect(result.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
      expect(result.postTerminationRequests).toBe(0);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);

test('cancelling branch replay keeps the persisted pause retryable in a fresh Worker', async () => {
  const name = 'par-fan-two-stage-single';
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  let sessionId = '';
  const first = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await branchSources(name),
  });
  try {
    const result = await executeDspyParallelStep(first.options, first.agent, store, { name });
    expect(result.pending).toBeDefined();
    sessionId = result.sessionId;
  } finally {
    await first.cleanup();
  }
  const rows = structuredClone(store.checkpoints.rows),
    writes = structuredClone(store.checkpoints.writes);
  const sources = await branchSources(name);
  sources['parallel_candidate.py'] += `
import asyncio
from galaxie.dspy import branches as join
async def branches(group):
    owner = asyncio.current_task()
    scheduled = False
    async def blocked():
        nonlocal scheduled
        if not scheduled:
            scheduled = True
            asyncio.get_running_loop().call_soon(owner.cancel)
        await asyncio.Event().wait()
    return await join({key: blocked for key in group})
`;
  const cancelledWorker = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources,
  });
  try {
    const cancelled = await executeDspyParallelStep(
      cancelledWorker.options,
      cancelledWorker.agent,
      store,
      { name, sessionId },
    );
    expect(cancelled.error).toEqual({ code: 'cancelled', message: 'The operation was cancelled.' });
    expect(cancelled.calls).toEqual([]);
    expect(cancelled.modelLabels).toEqual([]);
    expect(cancelled.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
    expect(store.checkpoints.rows).toEqual(rows);
    expect(store.checkpoints.writes).toEqual(writes);
    expect(cancelledWorker.workerErrors).toEqual([]);
  } finally {
    await cancelledWorker.cleanup();
  }
  const retry = await createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await branchSources(name),
  });
  try {
    const resumed = await executeDspyParallelStep(retry.options, retry.agent, store, {
      name,
      sessionId,
    });
    expect(resumed.error).toBeUndefined();
    expect(resumed.output).toEqual({
      before: parallelAnswers('single'),
      answers: parallelAnswers('single', 'after'),
    });
    expect(resumed.modelLabels.sort()).toEqual(['alpha:after', 'beta:after', 'gamma:after']);
    expect(resumed.calls).toEqual([]);
    expect(retry.workerErrors).toEqual([]);
  } finally {
    await retry.cleanup();
  }
}, 900000);

test('a branch catching cancellation cannot dispatch during cleanup', async () => {
  const name = 'par-fan-two-stage-single';
  const sources = await branchSources(name);
  sources['parallel_candidate.py'] += `
import asyncio
from galaxie.dspy import branches as join
async def branches(group):
    owner = asyncio.current_task()
    async def blocked():
        asyncio.get_running_loop().call_soon(owner.cancel)
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            return await next(iter(group.values()))()
    return await join({'survivor': blocked})
`;
  const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  const rows = structuredClone(store.checkpoints.rows),
    writes = structuredClone(store.checkpoints.writes);
  try {
    const cancelled = await executeDspyParallelStep(fixture.options, fixture.agent, store, {
      name,
    });
    expect(cancelled.error).toEqual({ code: 'cancelled', message: 'The operation was cancelled.' });
    expect(cancelled.calls).toEqual([]);
    expect(cancelled.modelLabels).toEqual([]);
    expect(cancelled.streams).toContainEqual({ kind: 'spike-tasks', count: 0 });
    expect(store.checkpoints.rows).toEqual(rows);
    expect(store.checkpoints.writes).toEqual(writes);
    expect(fixture.workerErrors).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
}, 900000);
