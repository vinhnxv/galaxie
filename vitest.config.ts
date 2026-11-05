// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

import {
  mcpAdminCommand,
  mcpCorpusAdminCommand,
} from './tests/conformance/support/mcp-commands.node.js';

const alias = {
  '@google/adk': fileURLToPath(
    new URL(
      './packages/adapter-adk/node_modules/@google/adk/dist/web/index_web.js',
      import.meta.url,
    ),
  ),
  '@galaxie/adapter-adk': fileURLToPath(
    new URL('./packages/adapter-adk/src/index.ts', import.meta.url),
  ),
  '@galaxie/adapter-pyodide': fileURLToPath(
    new URL('./packages/adapter-pyodide/src/index.ts', import.meta.url),
  ),
  '@galaxie/adapter-go': fileURLToPath(
    new URL('./packages/adapter-go/src/index.ts', import.meta.url),
  ),
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
  '@galaxie/models/transformers/worker': fileURLToPath(
    new URL('./packages/models/src/transformers/worker.ts', import.meta.url),
  ),
  '@galaxie/models/transformers': fileURLToPath(
    new URL('./packages/models/src/transformers/index.ts', import.meta.url),
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

/**
 * CI splits the suite into groups that share no file. The Python groups hold every test that needs
 * the Pyodide wheels, which dominate the run time; `general` is everything else. Without
 * `GALAXIE_TEST_GROUP` the whole suite runs, as it does on a developer machine; `python` is all
 * the Python groups together.
 */
const groupName = process.env['GALAXIE_TEST_GROUP'];
/** File-name terms that put a test in a named Python group. */
const pythonShards: Readonly<Record<string, string>> = {
  'python-dspy': 'dspy',
  'python-pydantic': 'pydantic',
  'python-adk': 'adk-python',
};
const pythonTerms = ['python', 'pyodide', 'dspy', 'pydantic'];
/**
 * Directories whose tests load the Pyodide wheels, whatever their names say, except the Go ones in
 * the example: those belong to `general`, so a Go-only change still runs them.
 */
const pythonDirectories = [
  'examples/rag-browser/test/**/!(*adk-go*|*go-gate*)',
  'packages/adapter-pyodide/test/**/*',
];
const groups = ['general', 'python', 'python-rest', ...Object.keys(pythonShards)];
if (groupName !== undefined && !groups.includes(groupName))
  throw new Error(`GALAXIE_TEST_GROUP must be one of ${groups.join(', ')}, not "${groupName}".`);

/**
 * Picks a project's files for the selected group. Every group is derived from the project's own
 * globs, so none reaches outside them, and `python-rest` is `python` minus the named groups.
 */
const forGroup = (
  include: string[],
  exclude: string[],
  prefix: string,
): { include: string[]; exclude: string[] } => {
  const named = (term: string): string[] =>
    include.map((glob) => glob.replace('*.test.', `*${term}*.test.`));
  const python = [
    ...pythonTerms.flatMap(named),
    ...pythonDirectories.map((directory) => `${prefix}${directory}.test.{ts,tsx}`),
  ];
  if (groupName === 'general') return { include, exclude: [...exclude, ...python] };
  if (groupName === 'python') return { include: python, exclude };
  if (groupName === 'python-rest')
    return {
      include: python,
      exclude: [...exclude, ...Object.values(pythonShards).flatMap(named)],
    };
  const term = groupName === undefined ? undefined : pythonShards[groupName];
  return term === undefined ? { include, exclude } : { include: named(term), exclude };
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
          ...forGroup(
            [
              'packages/*/test/**/*.test.ts',
              'tests/conformance/**/*.test.ts',
              'examples/*/test/**/*.test.ts',
            ],
            [
              ...configDefaults.exclude,
              'packages/storage-indexeddb/test/schema.test.ts',
              'packages/storage-indexeddb/test/saver.test.ts',
              'tests/conformance/indexeddb.test.ts',
            ],
            '',
          ),
          setupFiles: ['tests/conformance/support/clean-env.node.ts'],
        },
      },
      {
        root: fileURLToPath(new URL('./tests/conformance', import.meta.url)),
        resolve: { alias },
        optimizeDeps: {
          exclude: [
            '@mlc-ai/web-llm',
            '@huggingface/transformers',
            '@huggingface/transformers-structured-output',
            'onnxruntime-web',
          ],
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
            '@langchain/core/utils/function_calling',
            '@langchain/core/language_models/structured_output',
            '@langchain/core/output_parsers',
            '@langchain/core/tools',
            '@langchain/core/runnables',
            '@opentelemetry/sdk-trace',
            'zod',
            '@orama/orama',
            '@huggingface/jinja',
          ],
        },
        test: {
          name: 'browser',
          api: { host: '127.0.0.1', port: 63315, strictPort: true },
          globalSetup: ['support/mcp-global.node.ts'],
          ...forGroup(
            [
              '**/*.test.ts',
              '**/*.test.tsx',
              '../../packages/react/test/**/*.test.tsx',
              '../../packages/adapter-pyodide/test/**/*.test.ts',
              '../../packages/adapter-adk/test/**/*.test.ts',
              '../../packages/adapter-go/test/**/*.test.ts',
              '../../packages/storage-indexeddb/test/**/*.test.ts',
              '../../examples/*/test/**/*.test.ts',
            ],
            [
              ...configDefaults.exclude,
              '**/*.node.test.ts',
              '../../packages/adapter-pyodide/test/**/*.node.test.ts',
              '../../packages/adapter-adk/test/**/*.node.test.ts',
              '../../packages/adapter-go/test/**/*.node.test.ts',
              '../../examples/*/test/**/*.node.test.ts',
            ],
            '../../',
          ),
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
