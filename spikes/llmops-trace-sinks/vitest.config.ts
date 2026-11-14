// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const shared = ['@opentelemetry/api', '@langchain/core', '@langchain/langgraph'];

export default defineConfig({
  resolve: { dedupe: shared },
  plugins: [
    {
      name: 'spike-single-copy',
      enforce: 'pre',
      resolveId(source) {
        if (shared.some((name) => source === name || source.startsWith(`${name}/`)))
          return fileURLToPath(import.meta.resolve(source));
        return null;
      },
    },
  ],
  test: { environment: 'node', fileParallelism: false, testTimeout: 400_000 },
});
