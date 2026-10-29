// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

const alias = {
  '@galaxie/storage-indexeddb': fileURLToPath(
    new URL('./packages/storage-indexeddb/src/index.ts', import.meta.url),
  ),
  '@galaxie/example-english-tutor': fileURLToPath(
    new URL('./examples/english-tutor/src/index.ts', import.meta.url),
  ),
  '@galaxie/react': fileURLToPath(new URL('./packages/react/src/index.ts', import.meta.url)),
  '@galaxie/models/builtin-ai': fileURLToPath(
    new URL('./packages/models/src/builtin-ai/index.ts', import.meta.url),
  ),
  '@galaxie/models/webllm/worker': fileURLToPath(
    new URL('./packages/models/src/webllm/worker.ts', import.meta.url),
  ),
  '@galaxie/models/webllm': fileURLToPath(
    new URL('./packages/models/src/webllm/index.ts', import.meta.url),
  ),
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
          include: [
            'packages/*/test/**/*.test.ts',
            'tests/conformance/**/*.test.ts',
            'examples/*/test/**/*.test.ts',
          ],
          exclude: [
            ...configDefaults.exclude,
            'packages/storage-indexeddb/test/schema.test.ts',
            'packages/storage-indexeddb/test/saver.test.ts',
            'tests/conformance/indexeddb.test.ts',
          ],
          setupFiles: ['tests/conformance/support/clean-env.node.ts'],
        },
      },
      {
        root: fileURLToPath(new URL('./tests/conformance', import.meta.url)),
        resolve: { alias },
        optimizeDeps: {
          exclude: ['@mlc-ai/web-llm'],
          include: [
            'react',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            '@langchain/langgraph/web',
            '@langchain/langgraph-checkpoint',
            '@langchain/core/callbacks/base',
            '@langchain/core/language_models/chat_models',
            '@langchain/core/messages',
            '@langchain/core/outputs',
            '@langchain/core/utils/json_schema',
            '@langchain/core/language_models/structured_output',
            '@langchain/core/output_parsers',
            '@langchain/core/runnables',
            '@opentelemetry/sdk-trace',
            'zod',
          ],
        },
        test: {
          name: 'browser',
          include: [
            '**/*.test.ts',
            '**/*.test.tsx',
            '../../packages/react/test/**/*.test.tsx',
            '../../packages/storage-indexeddb/test/**/*.test.ts',
            '../../examples/*/test/**/*.test.ts',
          ],
          exclude: [
            ...configDefaults.exclude,
            '**/*.node.test.ts',
            '../../examples/*/test/**/*.node.test.ts',
          ],
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
