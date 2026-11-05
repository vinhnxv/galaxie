// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import type { RetrievalEvent } from '../src/retrieval/protocol.js';
import { RetrievalService } from '../src/retrieval/service.js';

const fake = vi.hoisted(() => ({
  download: vi.fn(async () => {
    throw new Error('Unexpected download.');
  }),
}));
vi.mock('../src/retrieval/model-files.js', async (original) => ({
  ...(await original<typeof import('../src/retrieval/model-files.js')>()),
  hasModelFiles: async () => true,
  downloadModelFiles: fake.download,
}));

test.skipIf(typeof indexedDB === 'undefined')(
  'verified model files allow a fresh build after clear without new consent',
  async () => {
    const original = navigator;
    vi.stubGlobal('navigator', {
      locks: original.locks,
      gpu: { requestAdapter: async () => ({}) },
    });
    const events: RetrievalEvent[] = [];
    const service = new RetrievalService((event) => events.push(event));
    const input = { appId: `cached-files-${crypto.randomUUID()}`, mock: false, corpus: null };
    try {
      await service.handle({ id: 1, type: 'init', input });
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        result: { status: 'ready', restored: false },
      });
      await service.handle({ id: 2, type: 'clear' });
      await service.handle({ id: 3, type: 'init', input });
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        result: { status: 'ready', restored: false },
      });
      expect(
        events.some(
          (event) => event.type === 'progress' && event.snapshot.status === 'awaiting-consent',
        ),
      ).toBe(false);
      expect(fake.download).not.toHaveBeenCalled();
      vi.stubGlobal('navigator', {
        locks: original.locks,
        gpu: { requestAdapter: async () => null },
      });
      await service.handle({ id: 4, type: 'init', input });
      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        message: 'WebGPU is required to index text.',
      });
      await service.handle({ id: 5, type: 'clear' });
    } finally {
      vi.unstubAllGlobals();
      await service.dispose();
    }
  },
);
