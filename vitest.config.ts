// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = {
  '@galaxie/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
  '@galaxie/adapter-langgraph': fileURLToPath(
    new URL('./packages/adapter-langgraph/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['packages/*/test/**/*.test.ts', 'tests/conformance/**/*.test.ts'],
          setupFiles: ['tests/conformance/support/clean-env.node.ts'],
        },
      },
    ],
  },
});
