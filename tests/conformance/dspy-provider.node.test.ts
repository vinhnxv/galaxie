// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  type PythonFixture,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import fixtures from './cases-dspy/provider-fixtures.json' with { type: 'json' };
import { providerScenarios } from './support/dspy-provider.js';
import { providerNativeReference, providerSources } from './support/dspy-provider-sources.node.js';
import { executeDspyReloadStep } from './support/dspy-restore.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900000;
interface Frame {
  readonly kind: string;
  readonly op: string;
  readonly payload: unknown;
}
interface Egress {
  readonly kind: string;
  readonly attempts: string[];
  readonly recorder: boolean;
  readonly unexpected: boolean;
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
function clean(worker: PythonFixture): void {
  expect(worker.workerErrors).toEqual([]);
  expect(worker.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
  const messages = frames(worker);
  const end = messages.findIndex((frame) => update(frame, 'spike-tasks'));
  expect(end).toBeGreaterThanOrEqual(0);
  expect(
    messages.filter((frame) => update(frame, 'spike-tasks')).map((frame) => frame.payload),
  ).toEqual([[[], 'updates', { kind: 'spike-tasks', count: 0 }]]);
  expect(
    messages
      .slice(end + 1)
      .filter((frame) => frame.kind === 'request' && ['model', 'capability'].includes(frame.op)),
  ).toEqual([]);
  expect(messages.filter((frame) => frame.kind === 'request' && frame.op === 'capability')).toEqual(
    [],
  );
}

const scenarios = ['pe-env-facts', ...providerScenarios.filter((name) => name !== 'pe-env-facts')];
test.each(scenarios)(
  'Node Pyodide characterizes DSPy provider shapes: %s',
  async (name) => {
    const worker = await createPythonFixture({
      framework: 'dspy',
      module: 'selected',
      sources: await providerSources(name),
    });
    try {
      const result = await executeDspyReloadStep(
        worker.options,
        worker.agent,
        {
          checkpoints: new MemoryByteCheckpoints(),
          recovery: new MemoryRecoveryStore(),
        },
        { name },
      );
      const observations = frames(worker).filter((frame) => update(frame, 'provider-egress'));
      expect(observations).toHaveLength(1);
      const observation = observations[0];
      if (!observation) throw new Error('Missing provider probe evidence.');
      const evidence = (observation.payload as unknown[])[2] as Egress;
      expect(evidence.unexpected).toBe(false);
      expect(evidence.attempts.every((target) => target === '127.0.0.1:9')).toBe(true);
      console.info(
        JSON.stringify({
          scenario: name,
          lane: 'node',
          requests: result.requests,
          capabilities: result.calls.length,
          code: (result.error as { code: string } | undefined)?.code,
          output: result.output,
          ...evidence,
        }),
      );
      expect(result.calls).toEqual([]);
      expect(result.pending).toBeUndefined();
      const count = [
        'pe-control-routed',
        'pe-schema-typed-ok',
        'pe-schema-typed-violation',
      ].includes(name)
        ? 1
        : 0;
      expect(result.requests).toBe(count);
      if (name === 'pe-control-routed' || name === 'pe-schema-typed-ok') {
        const reference = await providerNativeReference(
          name === 'pe-schema-typed-ok' ? 'literal' : 'control',
        );
        expect(result.error).toBeUndefined();
        expect(result.output).toEqual(reference.output);
        expect(payloads(worker)).toEqual(reference.requests);
        for (const payload of payloads(worker))
          expect((payload as { options: unknown }).options).not.toHaveProperty('jsonSchema');
      } else if (name === 'pe-env-facts') {
        expect(result.error).toBeUndefined();
        expect(JSON.parse((result.output as { facts: string }).facts)).toEqual(
          // Diverges from P10: httpx is locked, but not installed in the DSPy closure.
          { ...fixtures.predictions.P10.node, httpx: false },
        );
      } else if (name === 'pe-retrieve-local-rm') {
        expect(result.error).toBeUndefined();
        expect(result.output).toEqual({ passages: ['local a', 'local b'] });
      } else {
        const code = ['pe-lm-kwargs', 'pe-schema-response-format'].includes(name)
          ? 'unsupported'
          : 'executor_error';
        expect(result.error).toEqual({
          code,
          message:
            code === 'unsupported'
              ? 'This operation is unsupported.'
              : 'The executor or agent code failed.',
        });
        expect(result.output).toBeUndefined();
      }
      // Diverges from P2/P3: lm15 defaults to sockets, not FetchTransport, in Pyodide too.
      // requests/urllib3 may fail before fetch; XMLHttpRequest reachability is unmeasured.
      if (evidence.recorder) expect(evidence.attempts).toEqual([]);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'provider scenarios form a separate family with one native-only probe',
  async () => {
    expect(new Set(fixtures.scenarios).size).toBe(15);
    expect(providerScenarios).toHaveLength(14);
    expect(providerScenarios).not.toContain('pe-schema-candidate-shape');
    const directory = new URL('./cases-dspy/', import.meta.url);
    for (const filename of await readdir(directory)) {
      if (!filename.endsWith('fixtures.json') || filename === 'provider-fixtures.json') continue;
      const existing = await readFile(new URL(filename, directory), 'utf8');
      expect(fixtures.scenarios.filter((name) => existing.includes(name))).toEqual([]);
    }
  },
  timeout,
);
