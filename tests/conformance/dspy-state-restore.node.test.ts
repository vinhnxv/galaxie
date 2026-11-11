// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
import { stripBinding } from './support/dspy-state-binding.js';
import { stateRestorePrograms, stateRestoreScenarios } from './support/dspy-state-restore.js';
import { stateRestoreSources } from './support/dspy-state-restore-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

test.each(stateRestoreScenarios)(
  'Node Pyodide resumes a paused DSPy session across a state swap: $name',
  async (scenario) => {
    const pause = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await stateRestoreSources(scenario, 'pause'),
    });
    let resume: Awaited<ReturnType<typeof createPythonFixture>> | undefined;
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const sources = await stateRestoreSources(scenario, 'resume');
      if (scenario.swap !== 'same')
        resume = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
      const selected = resume ?? pause;
      const first = await executeDspyReloadStep(pause.options, pause.agent, store, {
        name: scenario.program,
      });
      expect(first.pending).toBeDefined();
      expect(first.error).toBeUndefined();
      expect(first.calls).toEqual(['before']);
      expect(first.requests).toBe(scenario.program === 'state-durable-early-model' ? 1 : 0);
      if (scenario.swap !== 'same') stripBinding(store.checkpoints.rows);
      const restored = await executeDspyReloadStep(selected.options, selected.agent, store, {
        name: scenario.program,
        sessionId: first.sessionId,
      });
      expect(restored.restored).toEqual(first.pending);
      expect(restored.calls).toEqual([]);
      expect(restored.pending).toBeUndefined();
      const checkpoint = JSON.parse(
        new TextDecoder().decode([...store.checkpoints.rows.values()].at(-1)?.checkpoint.bytes),
      );
      const replayed = restored.streams.filter(
        (value) => (value as { kind: string }).kind === 'replayed',
      );
      if (scenario.outcome === 'completes') {
        const state = JSON.parse(sources['state.json'] ?? '');
        expect(restored.error).toBeUndefined();
        expect(restored.output).toEqual({
          answer: 'done',
          receipt: 'RESTORED_CAPABILITY_SECRET',
          demos: state.demos.length,
          instructions: state.signature.instructions,
        });
        expect(restored.requests).toBe(1);
        expect(restored.consumed).toBe(true);
        expect(replayed).toHaveLength(1);
        expect(checkpoint.status).toBe('completed');
      } else {
        expect(restored.error).toEqual({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
        expect(restored.output).toBeUndefined();
        expect(restored.requests).toBe(0);
        expect(replayed).toEqual([]);
        expect(restored.streams).toContainEqual({ kind: 'unrecoverable' });
        expect(checkpoint.status).toBe('unrecoverable');
        await expect(
          executeDspyReloadStep(pause.options, pause.agent, store, {
            name: scenario.program,
            sessionId: first.sessionId,
          }),
        ).rejects.toMatchObject({ code: 'unrecoverable' });
      }
      expect(store.recovery.journal.size).toBe(1);
      expect(pause.workerErrors).toEqual([]);
      expect(selected.workerErrors).toEqual([]);
    } finally {
      await resume?.cleanup();
      await pause.cleanup();
    }
  },
  900000,
);

test('state restore scenarios form a separate, complete family', () => {
  const names = stateRestoreScenarios.map((scenario) => scenario.name);
  expect(new Set(names).size).toBe(names.length);
  const existing: readonly string[] = [
    ...dspyCases,
    ...dspyReloadCases,
    ...dspyRejectedRestoreCases,
    ...dspyStateCases,
  ];
  expect(names.filter((name) => existing.includes(name))).toEqual([]);
  expect([...new Set(stateRestoreScenarios.map((scenario) => scenario.program))]).toEqual(
    stateRestorePrograms,
  );
});
