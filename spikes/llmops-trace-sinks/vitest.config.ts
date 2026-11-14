// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shared = ['@opentelemetry/api', '@langchain/core', '@langchain/langgraph'];

export default defineConfig({
  resolve: {
    dedupe: shared,
    alias: shared.map((name) => ({
      find: name,
      replacement: fileURLToPath(new URL(`node_modules/${name}`, import.meta.url)),
    })),
  },
  test: { environment: 'node', fileParallelism: false, testTimeout: 180_000 },
});
