// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  type PythonFixture,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { dspySchemaCases, dspySchemaSpecs, executeDspySchema } from './support/dspy-schema.js';
import { dspySchemaSources } from './support/dspy-schema-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900000;
async function fixture(
  name: string,
  settings: { pause?: boolean; changed?: boolean } = {},
): Promise<PythonFixture> {
  return createPythonFixture({
    framework: 'dspy',
    module: 'selected',
    sources: await dspySchemaSources(name, settings),
  });
}
function clean(worker: PythonFixture): void {
  expect(worker.workerErrors).toEqual([]);
  expect(worker.requests.every((request) => request.url.startsWith('/python/'))).toBe(true);
}

test.each(dspySchemaCases)(
  'Node Pyodide matches DSPy schema golden: %s',
  async (name) => {
    const worker = await fixture(name);
    try {
      const result = await executeDspySchema(worker.options, worker.agent, name);
      expect(result.transcript).toEqual(
        JSON.parse(
          await readFile(
            new URL(`./golden-dspy-schema/${dspySchemaSpecs[name]?.golden}`, import.meta.url),
            'utf8',
          ),
        ),
      );
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test(
  'Node Pyodide refuses a schema route without structured-output before the provider',
  async () => {
    const name = 'so-json-adapter-schema';
    const worker = await fixture(name);
    try {
      const result = await executeDspySchema(worker.options, worker.agent, name, {
        feature: false,
      });
      expect(result.transcript.error).toEqual({
        code: 'unavailable',
        message: 'The requested service is unavailable.',
      });
      expect(result.transcript.requests).toEqual([]);
      expect(result.transcript.capabilities).toEqual([]);
      clean(worker);
    } finally {
      await worker.cleanup();
    }
  },
  timeout,
);

test.each([false, true])(
  'Node Pyodide schema restore changed=%s does not redispatch',
  async (changed) => {
    const name = 'so-json-adapter-schema';
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const firstWorker = await fixture(name, { pause: true });
    let secondWorker: PythonFixture | undefined;
    try {
      const first = await executeDspySchema(firstWorker.options, firstWorker.agent, name, {
        store,
      });
      expect(first.transcript.error).toBeNull();
      expect(first.pending).toBeDefined();
      expect(first.transcript.requests).toHaveLength(1);
      secondWorker = await fixture(name, { pause: true, changed });
      const second = await executeDspySchema(secondWorker.options, secondWorker.agent, name, {
        store,
        sessionId: first.sessionId,
      });
      expect(second.restored).toEqual(first.pending);
      expect(second.transcript.requests).toEqual([]);
      if (changed) {
        expect(second.transcript.error).toEqual({
          code: 'unrecoverable',
          message: 'Stored state cannot be recovered.',
        });
      } else {
        expect(second.transcript.error).toBeNull();
        expect(second.transcript.output).toEqual({ answer: 'done' });
        expect(second.replayed).toEqual([2]);
      }
      clean(firstWorker);
      clean(secondWorker);
    } finally {
      await secondWorker?.cleanup();
      await firstWorker.cleanup();
    }
  },
  timeout,
);
