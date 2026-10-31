// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { lockedWheels } from '../src/runtime-files.js';

test('DSPy async custom-engine gate runs offline in Node Pyodide without provider SDKs', async () => {
  const source = await readFile(
    new URL('../../../python/galaxie/tests/test_dspy_gate.py', import.meta.url),
    'utf8',
  );
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: {
      source,
      wheels: lockedWheels.filter((wheel) => wheel.frameworks?.includes('dspy')),
    },
  });
  try {
    const result = await new Promise<{ gate: unknown; fetches: number }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`The gate Worker exited with ${code}.`)));
    });
    expect(result.gate).toMatchObject({
      version: '3.4.1',
      anyio: true,
      termination: true,
      parseWithoutFallback: true,
    });
    expect(result.fetches).toBe(0);
  } finally {
    await worker.terminate();
  }
}, 60000);
