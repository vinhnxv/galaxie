// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  type PythonFixture,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import type { DspyTranscript } from './support/dspy.js';
import {
  dspyGoldenCases,
  dspyGoldenFamily,
  dspyGoldenSpecs,
  executeDspyGolden,
} from './support/dspy-golden.js';
import { dspyGoldenSources } from './support/dspy-golden-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900000;
async function golden(name: string): Promise<DspyTranscript> {
  const family = dspyGoldenFamily(name);
  return JSON.parse(
    await readFile(
      new URL(`./golden-dspy-${family}/${dspyGoldenSpecs[name]?.golden}`, import.meta.url),
      'utf8',
    ),
  ) as DspyTranscript;
}
async function fixture(name: string): Promise<PythonFixture> {
  return createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await dspyGoldenSources(name),
  });
}
function clean(worker: PythonFixture): void {
  expect(worker.workerErrors).toEqual([]);
  expect(worker.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
}

test.each(dspyGoldenCases)(
  'Node Pyodide matches the new DSPy golden: %s',
  async (name) => {
    const worker = await fixture(name);
    try {
      const result = await executeDspyGolden(worker.options, worker.agent, name);
      expect(result.transcript).toEqual(await golden(name));
      for (const evidence of result.sideEvidence) {
        if (evidence['kind'] === 'spike-tasks') expect(evidence['count']).toBe(0);
        else {
          expect(evidence['recorder']).toBe(true);
          expect(evidence['unexpected']).toBe(false);
          const attempts = evidence['attempts'] as string[];
          expect(attempts.every((target) => target === '127.0.0.1:9')).toBe(true);
          if (name === 'pe-retrieve-colbert') expect([0, 1]).toContain(attempts.length);
          else expect(attempts).toEqual([]);
          console.info(JSON.stringify({ lane: 'node', name, ...evidence }));
        }
      }
      if (name.startsWith('pe-'))
        expect(result.sideEvidence.map((value) => value['kind']).sort()).toEqual([
          'provider-egress',
          'spike-tasks',
        ]);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'Node Pyodide replays runtime LabeledFewShot across fresh Worker lifetimes',
  async () => {
    const name = 'rt-opt-labeled-two-stage';
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const firstWorker = await fixture(name);
    let secondWorker: PythonFixture | undefined;
    try {
      const first = await executeDspyGolden(firstWorker.options, firstWorker.agent, name, store);
      expect(first.transcript.error).toBeNull();
      expect(first.pending).toBeDefined();
      expect(first.transcript.requests).toHaveLength(1);
      secondWorker = await fixture(name);
      const second = await executeDspyGolden(
        secondWorker.options,
        secondWorker.agent,
        name,
        store,
        { sessionId: first.sessionId },
      );
      const expected = await golden(name);
      expect(second.restored).toEqual(first.pending);
      expect(second.pending).toBeUndefined();
      expect(second.transcript.error).toBeNull();
      expect(second.transcript.requests).toEqual(expected.requests.slice(1));
      expect([...first.transcript.requests, ...second.transcript.requests]).toEqual(
        expected.requests,
      );
      expect([...first.transcript.responses, ...second.transcript.responses]).toEqual(
        expected.responses,
      );
      expect([...first.transcript.interactions, ...second.transcript.interactions]).toEqual(
        expected.interactions,
      );
      expect([...(first.transcript.events ?? []), ...(second.transcript.events ?? [])]).toEqual(
        expected.events,
      );
      expect(second.transcript.output).toEqual(expected.output);
      const frames = secondWorker.fromWorker.map(
        (raw) => JSON.parse(raw) as { kind: string; op: string; payload: unknown[] },
      );
      const frontier = frames.findIndex(
        (frame) =>
          frame.kind === 'notify' &&
          frame.op === 'stream' &&
          (frame.payload[2] as { kind?: string })?.kind === 'replayed',
      );
      expect(frontier).toBeGreaterThanOrEqual(0);
      expect(
        frames
          .slice(0, frontier)
          .filter(
            (frame) => frame.kind === 'request' && ['model', 'capability'].includes(frame.op),
          ),
      ).toEqual([]);
      const submissions = await store.recovery.submissions(
        second.sessionId as Parameters<typeof store.recovery.submissions>[0],
      );
      expect(submissions).toHaveLength(1);
      expect(submissions.every((submission) => submission.status === 'consumed')).toBe(true);
      clean(firstWorker);
      clean(secondWorker);
    } finally {
      await secondWorker?.cleanup();
      await firstWorker.cleanup();
    }
  },
  timeout,
);
