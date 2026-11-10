// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@galaxie-ai/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
      '@galaxie-ai/ui-protocol': fileURLToPath(
        new URL('../../packages/ui-protocol/src/index.ts', import.meta.url),
      ),
    },
    dedupe: ['zod', '@opentelemetry/api'],
  },
  test: { environment: 'node' },
});
