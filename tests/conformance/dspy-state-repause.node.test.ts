// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import fixtures from './cases-dspy/engine-fixtures.json' with { type: 'json' };
import { dspyCases } from './support/dspy.js';
import { parallelScenarios } from './support/dspy-parallel.js';
import {
  dspyRejectedRestoreCases,
  dspyReloadCases,
  executeDspyReloadStep,
} from './support/dspy-restore.js';
import { dspySources } from './support/dspy-sources.node.js';
import { dspyStateCases } from './support/dspy-state.js';
import { observeStateBind, stateBindScenarios } from './support/dspy-state-bind.js';
import { expectedBinding, readBinding, stripBinding } from './support/dspy-state-binding.js';
import { stateRestoreScenarios } from './support/dspy-state-restore.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test('Node Pyodide binds a legacy session when it pauses again', async () => {
  const sources = { ...(await dspySources('durable-two')), 'unrelated.json': '{}' };
  const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
  const workers: Awaited<ReturnType<typeof createPythonFixture>>[] = [];
  const lifetime = async (sessionId?: string, changed = false) => {
    const fixture = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: { ...sources, 'unrelated.json': changed ? '[]' : '{}' },
    });
    workers.push(fixture);
    const observed = observeStateBind(fixture.options);
    return {
      result: executeDspyReloadStep(observed.options, fixture.agent, store, {
        name: 'durable-two',
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
      traffic: observed.traffic,
    };
  };
  try {
    const first = await (await lifetime()).result;
    expect(first.error).toBeUndefined();
    expect(first.pending).toBeDefined();
    expect(first.calls).toEqual(['before']);
    expect(first.requests).toBe(0);
    expect(readBinding(store.checkpoints.rows)).toMatch(/^[0-9a-f]{64}$/);
    expect(readBinding(store.checkpoints.rows)).toBe(expectedBinding(sources));
    stripBinding(store.checkpoints.rows);
    expect(readBinding(store.checkpoints.rows)).toBeUndefined();

    const resumed = await lifetime(first.sessionId);
    const second = await resumed.result;
    expect(second.error).toBeUndefined();
    expect(second.restored).toEqual(first.pending);
    expect(second.pending).toBeDefined();
    expect(second.pending?.viewRevision).toBe('second');
    expect(second.pending?.interactionId).not.toBe(first.pending?.interactionId);
    expect(second.output).toBeUndefined();
    expect(second.calls).toEqual([]);
    expect(second.requests).toBe(0);
    expect(resumed.traffic).toEqual({ models: 0, capabilities: 0, replayed: 1 });
    expect(readBinding(store.checkpoints.rows)).toMatch(/^[0-9a-f]{64}$/);
    expect(readBinding(store.checkpoints.rows)).toBe(expectedBinding(sources));
    const saved = structuredClone({
      rows: store.checkpoints.rows,
      writes: store.checkpoints.writes,
      effects: store.recovery.journal,
    });

    const changed = await lifetime(first.sessionId, true);
    await expect(changed.result).rejects.toMatchObject({
      code: 'unrecoverable',
      message: 'Stored state cannot be recovered.',
    });
    expect(changed.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
    expect({
      rows: store.checkpoints.rows,
      writes: store.checkpoints.writes,
      effects: store.recovery.journal,
    }).toEqual(saved);

    const rollback = await lifetime(first.sessionId);
    const completed = await rollback.result;
    expect(completed.restored).toEqual(second.pending);
    expect(completed.pending).toBeUndefined();
    expect(completed.error).toBeUndefined();
    expect(completed.output).toEqual({
      answer: 'done',
      receipt: 'RESTORED_CAPABILITY_SECRET',
    });
    expect(completed.calls).toEqual([]);
    expect(completed.requests).toBe(1);
    expect(completed.consumed).toBe(true);
    expect(rollback.traffic).toEqual({ models: 1, capabilities: 0, replayed: 1 });
    expect(store.recovery.journal.size).toBe(1);
    for (const worker of workers) expect(worker.workerErrors).toEqual([]);
  } finally {
    for (const worker of workers) await worker.cleanup();
  }
}, 900000);

test('engine scenario names do not collide with existing families', () => {
  const names = fixtures.scenarios.map((scenario) => scenario.name);
  expect(new Set(names).size).toBe(names.length);
  const existing: readonly string[] = [
    ...dspyCases,
    ...dspyReloadCases,
    ...dspyRejectedRestoreCases,
    ...dspyStateCases,
    ...stateBindScenarios.map((scenario) => scenario.name),
    ...stateRestoreScenarios.map((scenario) => scenario.name),
    ...parallelScenarios,
  ];
  expect(names.filter((name) => existing.includes(name))).toEqual([]);
}, 900000);
