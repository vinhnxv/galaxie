// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, test, vi } from 'vitest';
import { probeGoVersion, runGo } from '../src/families/go.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: execute }),
}));

beforeEach(() => {
  execute.mockReset();
});

test('a failed Go version command fails instead of producing an unmeasured row', async () => {
  execute.mockRejectedValue(new Error('version command failed'));
  await expect(probeGoVersion()).rejects.toThrow('version command failed');
});

test.each(['glue fetch', 'wasm build'])(
  '%s failures cannot become unmeasured rows',
  async (stage) => {
    execute.mockResolvedValueOnce({ stdout: 'go1.27.3' });
    if (stage === 'wasm build') execute.mockResolvedValueOnce({ stdout: '' });
    execute.mockRejectedValueOnce(new Error(`${stage} failed`));
    await expect(runGo()).rejects.toThrow(`${stage} failed`);
  },
);
