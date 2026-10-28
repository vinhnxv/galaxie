// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

const alias = {
  '@galaxie/models/mock': fileURLToPath(new URL('./packages/models/src/mock.ts', import.meta.url)),
  '@galaxie/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
  '@galaxie/adapter-langgraph': fileURLToPath(
    new URL('./packages/adapter-langgraph/src/index.ts', import.meta.url),
  ),
};

const config: ViteUserConfig = defineConfig({
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
      {
        root: fileURLToPath(new URL('./tests/conformance', import.meta.url)),
        resolve: { alias },
        optimizeDeps: {
          include: [
            '@langchain/langgraph/web',
            '@langchain/core/callbacks/base',
            '@langchain/core/language_models/chat_models',
            '@langchain/core/messages',
            '@langchain/core/outputs',
            '@opentelemetry/sdk-trace',
            'zod',
          ],
        },
        test: {
          name: 'browser',
          include: ['**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.node.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium', name: 'browser (chromium)' }],
          },
        },
      },
    ],
  },
});

export default config;
