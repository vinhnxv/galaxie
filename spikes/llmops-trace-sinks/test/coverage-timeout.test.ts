// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { expect, test } from 'vitest';
import { withCoverageTimeout } from '../src/coverage-timeout.js';

test('a hung Python measurement aborts and closes its worker and asset server', async () => {
  const server = createServer((_request, response) => response.end('fixture'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
  let signal: AbortSignal | undefined;
  let exited = false;
  worker.once('exit', () => {
    exited = true;
  });
  try {
    await expect(
      withCoverageTimeout(
        (activeSignal) => {
          signal = activeSignal;
          return new Promise<never>(() => {});
        },
        async () => {
          await worker.terminate();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        20,
      ),
    ).rejects.toThrow('Python coverage timed out');
    expect(signal?.aborted).toBe(true);
    expect(exited).toBe(true);
    expect(server.listening).toBe(false);
  } finally {
    await worker.terminate();
    server.close();
  }
});

test('Python cleanup also runs after a measurement failure', async () => {
  let cleaned = false;
  await expect(
    withCoverageTimeout(
      async () => {
        throw new Error('runtime failure');
      },
      async () => {
        cleaned = true;
      },
    ),
  ).rejects.toThrow('runtime failure');
  expect(cleaned).toBe(true);
});
