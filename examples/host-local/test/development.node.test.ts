// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test, vi } from 'vitest';
import { createMockModels } from '../src/mock-script.js';
import { createLocalHost } from '../src/runtime.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test.each([true, false])(
  'host-local enables warning logging only with DEV %s',
  async (development) => {
    vi.stubEnv('DEV', development);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const availability = vi.fn(() => ({ status: 'unavailable' as const }));
    const models = createMockModels();
    const host = createLocalHost({ ...models, routing: { ...models.routing, availability } });
    try {
      await host.createInstance();
      expect(availability).toHaveBeenCalledTimes(development ? 2 : 0);
      expect(warn.mock.calls).toEqual(
        development
          ? [
              ['[galaxie]', 'role_without_provider', 'quiz.generate', ''],
              ['[galaxie]', 'role_without_provider', 'tutor.feedback', ''],
            ]
          : [],
      );
    } finally {
      await host.runtime.dispose();
    }
  },
);
