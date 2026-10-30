// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

import {
  mcpAdminCommand,
  mcpCorpusAdminCommand,
} from './tests/conformance/support/mcp-commands.node.js';

const alias = {
  '@orama/orama': fileURLToPath(
    new URL('./examples/rag-browser/node_modules/@orama/orama/dist/esm/index.js', import.meta.url),
  ),
  eslint: fileURLToPath(
    new URL('./packages/eslint-plugin/node_modules/eslint/lib/api.js', import.meta.url),
  ),
  '@galaxie/eslint-plugin': fileURLToPath(
    new URL('./packages/eslint-plugin/src/index.ts', import.meta.url),
  ),
  '@galaxie/tools-mcp': fileURLToPath(
    new URL('./packages/tools-mcp/src/index.ts', import.meta.url),
  ),
  '@galaxie/example-mcp-server': fileURLToPath(
    new URL('./examples/mcp-server/src/index.ts', import.meta.url),
  ),
  '@modelcontextprotocol/sdk/client/index.js': fileURLToPath(
    new URL(
      './packages/tools-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
      import.meta.url,
    ),
  ),
  '@modelcontextprotocol/sdk/client/streamableHttp.js': fileURLToPath(
    new URL(
      './packages/tools-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js',
      import.meta.url,
    ),
  ),
  '@modelcontextprotocol/sdk/types.js': fileURLToPath(
    new URL(
      './packages/tools-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js',
      import.meta.url,
    ),
  ),
  '@galaxie/storage-indexeddb': fileURLToPath(
    new URL('./packages/storage-indexeddb/src/index.ts', import.meta.url),
  ),
  '@galaxie/example-english-tutor': fileURLToPath(
    new URL('./examples/english-tutor/src/index.ts', import.meta.url),
  ),
  '@galaxie/react': fileURLToPath(new URL('./packages/react/src/index.ts', import.meta.url)),
  '@galaxie/models/openai': fileURLToPath(
    new URL('./packages/models/src/openai/index.ts', import.meta.url),
  ),
  '@langchain/openai': fileURLToPath(
    new URL('./packages/models/node_modules/@langchain/openai/dist/index.js', import.meta.url),
  ),
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
  server: { host: '127.0.0.1' },
  test: {
    api: { host: '127.0.0.1' },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          globalSetup: ['tests/conformance/support/mcp-global.node.ts'],
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
          exclude: ['@mlc-ai/web-llm', '@huggingface/transformers', 'onnxruntime-web'],
          include: [
            'react',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            '@langchain/langgraph/web',
            '@langchain/openai',
            '@modelcontextprotocol/sdk/client/index.js',
            '@modelcontextprotocol/sdk/client/streamableHttp.js',
            '@modelcontextprotocol/sdk/types.js',
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
            '@orama/orama',
          ],
        },
        test: {
          name: 'browser',
          api: { host: '127.0.0.1', port: 63315, strictPort: true },
          globalSetup: ['support/mcp-global.node.ts'],
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
            commands: { mcpAdmin: mcpAdminCommand, mcpCorpusAdmin: mcpCorpusAdminCommand },
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
