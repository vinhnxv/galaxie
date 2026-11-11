// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { dspyCases } from './support/dspy.js';
import {
  dspyRejectedRestoreCases,
  dspyReloadCases,
  executeDspyReloadStep,
} from './support/dspy-restore.js';
import { dspyStateCases } from './support/dspy-state.js';
import { observeStateBind, stateBindScenarios } from './support/dspy-state-bind.js';
import { stateBindSources } from './support/dspy-state-bind-sources.node.js';
import { stateRestoreScenarios } from './support/dspy-state-restore.js';
import { stateRestoreSources } from './support/dspy-state-restore-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test.each(stateBindScenarios.filter((scenario) => scenario.lanes.includes('node')))(
  'Node Pyodide binds paused state before replay: $name',
  async (scenario) => {
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const fixtures: Awaited<ReturnType<typeof createPythonFixture>>[] = [];
    const lifetime = async (phase: 'pause' | 'resume', sessionId?: string) => {
      const fixture = await createPythonFixture({
        framework: 'dspy',
        module: 'selected',
        sources: await stateBindSources(scenario, phase),
      });
      fixtures.push(fixture);
      const observed = observeStateBind(fixture.options);
      const result = executeDspyReloadStep(observed.options, fixture.agent, store, {
        name: scenario.program,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      return { result, traffic: observed.traffic };
    };
    try {
      const first = await (await lifetime('pause')).result;
      expect(first.pending).toBeDefined();
      expect(first.error).toBeUndefined();
      expect(first.calls).toEqual(['before']);
      expect(first.requests).toBe(scenario.program === 'state-durable-early-model' ? 1 : 0);
      const saved = structuredClone({
        rows: store.checkpoints.rows,
        writes: store.checkpoints.writes,
        effects: store.recovery.journal,
      });
      const resumed = await lifetime('resume', first.sessionId);
      if (scenario.predicted === 'unrecoverable') {
        await expect(resumed.result).rejects.toMatchObject({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
        expect(resumed.traffic).toEqual({ models: 0, capabilities: 0, replayed: 0 });
        expect({
          rows: store.checkpoints.rows,
          writes: store.checkpoints.writes,
          effects: store.recovery.journal,
        }).toEqual(saved);
      } else {
        const restored = await resumed.result;
        const sources = await stateBindSources(scenario, 'resume');
        const state = JSON.parse(sources['state.json'] ?? '');
        expect(restored.restored).toEqual(first.pending);
        expect(restored.error).toBeUndefined();
        expect(restored.pending).toBeUndefined();
        expect(restored.output).toEqual({
          answer: 'done',
          receipt: 'RESTORED_CAPABILITY_SECRET',
          demos: state.demos.length,
          instructions: state.signature.instructions,
        });
        expect(restored.calls).toEqual([]);
        expect(restored.requests).toBe(1);
        expect(restored.consumed).toBe(true);
        expect(resumed.traffic).toEqual({ models: 1, capabilities: 0, replayed: 1 });
      }
      if (scenario.then === 'original') {
        const rollback = await lifetime('pause', first.sessionId);
        const restored = await rollback.result;
        expect(restored.restored).toEqual(first.pending);
        expect(restored.error).toBeUndefined();
        expect(restored.output).toMatchObject({ answer: 'done', demos: 2 });
        expect(restored.calls).toEqual([]);
        expect(rollback.traffic).toEqual({ models: 1, capabilities: 0, replayed: 1 });
      }
      const checkpoint = JSON.parse(
        new TextDecoder().decode([...store.checkpoints.rows.values()].at(-1)?.checkpoint.bytes),
      );
      expect(checkpoint.status).toBe('completed');
      expect(store.recovery.journal.size).toBe(1);
      for (const fixture of fixtures) expect(fixture.workerErrors).toEqual([]);
    } finally {
      for (const fixture of fixtures) await fixture.cleanup();
    }
  },
  900000,
);

test('Node state digest covers BOM-stripped Worker bytes', async () => {
  const scenario = stateRestoreScenarios.find((scenario) => scenario.name === 'fingerprint-same');
  if (!scenario) throw new Error('The fingerprint scenario is missing.');
  const sources = await stateRestoreSources(scenario, 'pause');
  const visible = sources['state.json'] ?? '';
  const served = `\uFEFF${visible}`;
  sources['state.json'] = served;
  const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
  try {
    const first = await executeDspyReloadStep(
      fixture.options,
      fixture.agent,
      { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() },
      { name: scenario.program },
    );
    if (!first.pending) throw new Error('The fingerprint pause is missing.');
    const digest = (first.pending.props as { stateDigest: string }).stateDigest;
    expect(digest).toBe(createHash('sha256').update(visible).digest('hex'));
    expect(digest).not.toBe(createHash('sha256').update(served).digest('hex'));
    expect(fixture.workerErrors).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
}, 900000);

test('state binding scenario names do not collide with existing families', () => {
  const names = stateBindScenarios.map((scenario) => scenario.name);
  expect(new Set(names).size).toBe(names.length);
  const existing: readonly string[] = [
    ...dspyCases,
    ...dspyReloadCases,
    ...dspyRejectedRestoreCases,
    ...dspyStateCases,
    ...stateRestoreScenarios.map((scenario) => scenario.name),
  ];
  expect(names.filter((name) => existing.includes(name))).toEqual([]);
});
