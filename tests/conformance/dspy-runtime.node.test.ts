// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  type PythonFixture,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { executeDspyReloadStep } from './support/dspy-restore.js';
import { runtimeScenarios } from './support/dspy-runtime.js';
import { runtimeNativeReference, runtimeSources } from './support/dspy-runtime-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900000;
const stores = (): { checkpoints: MemoryByteCheckpoints; recovery: MemoryRecoveryStore } => ({
  checkpoints: new MemoryByteCheckpoints(),
  recovery: new MemoryRecoveryStore(),
});
const fixture = async (name: string): Promise<PythonFixture> =>
  createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await runtimeSources(name),
  });

interface Frame {
  readonly kind: string;
  readonly op: string;
  readonly payload: unknown;
}
function frames(worker: PythonFixture): Frame[] {
  return worker.fromWorker.map((raw) => JSON.parse(raw) as Frame);
}
function payloads(worker: PythonFixture): unknown[] {
  return frames(worker)
    .filter((value) => value.kind === 'request' && value.op === 'model')
    .map((value) => value.payload);
}
function update(frame: Frame, kind: string): boolean {
  return (
    frame.kind === 'notify' &&
    frame.op === 'stream' &&
    Array.isArray(frame.payload) &&
    (frame.payload[2] as { kind?: string } | undefined)?.kind === kind
  );
}
function clean(worker: PythonFixture, prepared = true): void {
  expect(worker.workerErrors).toEqual([]);
  expect(worker.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
  const messages = frames(worker);
  const end = messages.findIndex((frame) => update(frame, 'spike-tasks'));
  if (prepared) {
    expect(end).toBeGreaterThanOrEqual(0);
    expect(
      messages.filter((frame) => update(frame, 'spike-tasks')).map((frame) => frame.payload),
    ).toEqual([[[], 'updates', { kind: 'spike-tasks', count: 0 }]]);
    expect(
      messages
        .slice(end + 1)
        .filter((frame) => frame.kind === 'request' && ['model', 'capability'].includes(frame.op)),
    ).toEqual([]);
  }
  expect(messages.filter((frame) => frame.kind === 'request' && frame.op === 'capability')).toEqual(
    [],
  );
}

// Measure the event-loop hypothesis first, without repeating the earlier thread-start probe.
const singleScenarios = [
  'rt-sync-to-thread',
  ...runtimeScenarios.filter(
    (name) =>
      !['rt-sync-to-thread', 'rt-sync-forward-only', 'rt-opt-labeled-two-stage'].includes(name),
  ),
];
test.each(singleScenarios)(
  'Node Pyodide characterizes DSPy runtime entry points: %s',
  async (name) => {
    const worker = await fixture(name);
    try {
      const result = await executeDspyReloadStep(worker.options, worker.agent, stores(), { name });
      console.info(JSON.stringify({ scenario: name, lane: 'node', ...result }));
      expect(result.calls).toEqual([]);
      expect(result.pending).toBeUndefined();
      if (name === 'rt-sync-acall-control' || name === 'rt-opt-labeled') {
        expect(result.error).toBeUndefined();
        expect(result.requests).toBe(1);
        if (name === 'rt-opt-labeled') {
          const reference = await runtimeNativeReference();
          expect(result.output).toEqual(reference.output);
          expect(payloads(worker)).toEqual(reference.requests);
        } else expect(result.output).toEqual({ answer: 'done' });
      } else {
        const code = ['rt-opt-labeled-naive', 'rt-opt-gepa'].includes(name)
          ? 'executor_error'
          : 'unsupported';
        expect(result.error).toEqual({
          code,
          message:
            code === 'unsupported'
              ? 'This operation is unsupported.'
              : 'The executor or agent code failed.',
        });
        expect(result.output).toBeUndefined();
        expect(result.requests).toBe(0);
        expect(payloads(worker)).toEqual([]);
      }
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'Node Pyodide refuses the sync-only module during prepare before its body runs',
  async () => {
    const worker = await fixture('rt-sync-forward-only');
    try {
      await expect(
        executeDspyReloadStep(worker.options, worker.agent, stores(), {
          name: 'rt-sync-forward-only',
        }),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(payloads(worker)).toEqual([]);
      clean(worker, false);
      console.info(
        JSON.stringify({
          scenario: 'rt-sync-forward-only',
          lane: 'node',
          phase: 'prepare',
          code: 'unsupported',
          requests: 0,
        }),
      );
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'Node Pyodide restores runtime LabeledFewShot in a fresh Worker without replay dispatch',
  async () => {
    const name = 'rt-opt-labeled-two-stage';
    const store = stores();
    const firstWorker = await fixture(name);
    let restoredWorker: PythonFixture | undefined;
    try {
      const first = await executeDspyReloadStep(firstWorker.options, firstWorker.agent, store, {
        name,
      });
      expect(first.error).toBeUndefined();
      expect(first.pending).toBeDefined();
      expect(first.requests).toBe(1);
      clean(firstWorker);
      restoredWorker = await fixture(name);
      const restored = await executeDspyReloadStep(
        restoredWorker.options,
        restoredWorker.agent,
        store,
        {
          name,
          sessionId: first.sessionId,
        },
      );
      console.info(JSON.stringify({ scenario: name, lane: 'node', first, restored }));
      expect(restored.error).toBeUndefined();
      expect(restored.restored).toEqual(first.pending);
      expect(restored.pending).toBeUndefined();
      expect(restored.requests).toBe(1);
      expect(restored.calls).toEqual([]);
      expect(restored.consumed).toBe(true);
      expect(
        restored.streams.filter((value) => (value as { kind: string }).kind === 'replayed'),
      ).toHaveLength(1);
      const messages = frames(restoredWorker);
      const frontier = messages.findIndex((frame) => update(frame, 'replayed'));
      expect(frontier).toBeGreaterThanOrEqual(0);
      expect(
        messages
          .slice(0, frontier)
          .filter(
            (frame) => frame.kind === 'request' && ['model', 'capability'].includes(frame.op),
          ),
      ).toEqual([]);
      const reference = await runtimeNativeReference(true);
      expect(restored.output).toEqual(reference.output);
      expect([...payloads(firstWorker), ...payloads(restoredWorker)]).toEqual(reference.requests);
      clean(restoredWorker);
    } finally {
      await restoredWorker?.cleanup();
      await firstWorker.cleanup();
    }
  },
  timeout,
);

test(
  'runtime scenarios form a separate fourteen-program family',
  async () => {
    expect(new Set(runtimeScenarios).size).toBe(14);
    const directory = new URL('./cases-dspy/', import.meta.url);
    for (const filename of await readdir(directory)) {
      if (!filename.endsWith('fixtures.json') || filename === 'runtime-fixtures.json') continue;
      const existing = await readFile(new URL(filename, directory), 'utf8');
      expect(runtimeScenarios.filter((name) => existing.includes(name))).toEqual([]);
    }
  },
  timeout,
);
