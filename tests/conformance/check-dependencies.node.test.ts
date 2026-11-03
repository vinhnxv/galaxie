// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-dependencies.ts', import.meta.url));

const UNCONDITIONALLY_READ_DIRECTORIES = [
  'packages/core/src',
  'packages/adapter-langgraph/src',
  'packages/models/src',
  'packages/storage-indexeddb/src',
  'packages/eslint-plugin/src',
  'examples/host-local/src',
  'examples/rag-browser/src',
  'examples/host-remote/src',
  'examples/host-remote/server',
  'examples/host-remote/test',
  'tests/conformance',
  'scripts',
  ...[
    'core',
    'adapter-langgraph',
    'adapter-pyodide',
    'adapter-adk',
    'models',
    'react',
    'storage-indexeddb',
    'tools-mcp',
  ].map((name) => `packages/${name}/dist`),
];

const FILES: Record<string, string> = {
  'packages/core/package.json': JSON.stringify({
    peerDependencies: { '@opentelemetry/api': '1', zod: '4' },
  }),
  'packages/models/package.json': JSON.stringify({
    peerDependencies: {
      '@huggingface/transformers': '4.3.1',
      '@huggingface/transformers-structured-output': '4.3.1',
      '@langchain/core': '1',
      '@langchain/openai': '1.6.3',
      '@mlc-ai/web-llm': '0.2.86',
    },
    peerDependenciesMeta: {
      '@huggingface/transformers': { optional: true },
      '@huggingface/transformers-structured-output': { optional: true },
      '@langchain/openai': { optional: true },
      '@mlc-ai/web-llm': { optional: true },
    },
  }),
};

function run(extra: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'galaxie-deps-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of UNCONDITIONALLY_READ_DIRECTORIES)
    mkdirSync(join(root, directory), { recursive: true });
  for (const [path, content] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

const adk = (specifier: string, kind = 'import'): string =>
  kind === 'type'
    ? `import type { X } from '${specifier}';\n`
    : `import { X } from '${specifier}';\nexport { X };\n`;

test('an empty skeleton passes', () => {
  expect(run({})).toMatchObject({ status: 0, output: '' });
});

test('the ADK adapter may import the root specifier, core, LangChain core and relative files', () => {
  const result = run({
    'packages/adapter-adk/src/a.ts': [
      adk('@google/adk'),
      adk('@galaxie/core'),
      adk('@langchain/core/messages'),
      adk('./b.js'),
      adk('zod'),
      adk('@google/genai', 'type'),
    ].join(''),
  });
  expect(result).toMatchObject({ status: 0, output: '' });
});

test.each([
  '@google/adk/a2a',
  '@google/adk/sessions/database',
  '@google/adk/tools/mcp',
  '@google/adk/telemetry/gcp',
  '@google/adk/artifacts/gcs',
  '@google/adk/agents/agent-engine',
  '@google/adk/dist/web/index_web.js',
])('a subpath import of %s fails', (subpath) => {
  const result = run({ 'packages/adapter-adk/src/a.ts': adk(subpath) });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`packages/adapter-adk/src/a.ts: ADK subpath imports`);
  expect(result.output).toContain(subpath);
});

test('a runtime import of @google/genai fails and a type-only import passes', () => {
  const failing = run({ 'packages/adapter-adk/src/a.ts': adk('@google/genai') });
  expect(failing.status).toBe(1);
  expect(failing.output).toContain('@google/genai may be imported as a type only');
  expect(run({ 'packages/adapter-adk/src/a.ts': adk('@google/genai', 'type') }).status).toBe(0);
});

test.each([
  ["import { type X } from '@google/genai';\nexport type { X };\n"],
  ["export { type X } from '@google/genai';\n"],
])('an inline type specifier of @google/genai still loads the module and fails', (source) => {
  const result = run({ 'packages/adapter-adk/src/a.ts': source });
  expect(result.status).toBe(1);
  expect(result.output).toContain('@google/genai may be imported as a type only');
});

test.each(['../../adapter-langgraph/src/index.js', '../node_modules/@google/adk/dist/index.js'])(
  'a relative import of %s fails',
  (specifier) => {
    const result = run({ 'packages/adapter-adk/src/a.ts': adk(specifier) });
    expect(result.status).toBe(1);
    expect(result.output).toContain('reaches into a dependency or another adapter');
  },
);

test.each(['@galaxie/adapter-langgraph', '@galaxie/adapter-pyodide', '@langchain/langgraph/web'])(
  'the ADK adapter importing %s fails',
  (specifier) => {
    const result = run({ 'packages/adapter-adk/src/a.ts': adk(specifier) });
    expect(result.status).toBe(1);
    expect(result.output).toContain('must not depend on another executor adapter');
  },
);

test('the ADK adapter rejects an unlisted package', () => {
  const result = run({ 'packages/adapter-adk/src/a.ts': adk('left-pad') });
  expect(result.status).toBe(1);
  expect(result.output).toContain('forbidden ADK adapter import left-pad');
});

test('only test files of the ADK adapter may import test tooling', () => {
  expect(run({ 'packages/adapter-adk/test/a.test.ts': adk('vitest') }).status).toBe(0);
  expect(run({ 'packages/adapter-adk/test/a.test.ts': adk('node:fs') }).status).toBe(0);
  expect(run({ 'packages/adapter-adk/src/a.ts': adk('vitest') }).status).toBe(1);
  expect(run({ 'packages/adapter-adk/src/a.ts': adk('node:fs') }).status).toBe(1);
});

test('the built ADK adapter may not import Node built-ins or mention async_hooks', () => {
  expect(run({ 'packages/adapter-adk/dist/a.js': "import fs from 'node:fs';\n" }).status).toBe(1);
  expect(run({ 'packages/adapter-adk/dist/a.js': '// async_hooks\n' }).status).toBe(1);
});

test.each([
  ['packages/core/src/a.ts', adk('@google/adk')],
  ['packages/models/src/a.ts', adk('@google/adk')],
  ['packages/react/src/a.ts', adk('@google/adk')],
  ['packages/core/test/a.test.ts', adk('@google/adk/a2a')],
  ['packages/models/vite.config.ts', adk('@google/adk')],
  ['examples/host-local/src/a.ts', adk('@google/adk')],
  ['examples/rag-browser/src/a.ts', adk('@google/adk/a2a')],
  ['tests/conformance/a.test.ts', adk('@google/adk/a2a')],
])('%s importing ADK fails', (path, source) => {
  const result = run({ [path]: source });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${path}: ADK imports belong only in packages/adapter-adk`);
});

test('the conformance lane may import the root specifier for native reference runs', () => {
  expect(run({ 'tests/conformance/a.test.ts': adk('@google/adk') }).status).toBe(0);
});

const TRANSFORMERS = 'packages/models/src/transformers';
const modelsPackage = (peers: Record<string, string>, optional: readonly string[]): string =>
  JSON.stringify({
    peerDependencies: { '@langchain/core': '1', '@langchain/openai': '1.6.3', ...peers },
    peerDependenciesMeta: {
      '@langchain/openai': { optional: true },
      ...Object.fromEntries(optional.map((name) => [name, { optional: true }])),
    },
  });
const WEBLLM = { '@mlc-ai/web-llm': '0.2.86' };

test('the Transformers.js runtime file may import the library dynamically and without types', () => {
  const result = run({
    [`${TRANSFORMERS}/runtime.ts`]:
      "export const load = (): Promise<unknown> => import('@huggingface/transformers');\n",
  });
  expect(result).toMatchObject({ status: 0, output: '' });
});

test.each([
  [
    'a static import in runtime.ts',
    'runtime.ts',
    "import { env } from '@huggingface/transformers';\nexport { env };\n",
  ],
  [
    'a types import in runtime.ts',
    'runtime.ts',
    "import type { PreTrainedTokenizer } from '@huggingface/transformers';\nexport type { PreTrainedTokenizer };\n",
  ],
  [
    'a dynamic import in chat-model.ts',
    'chat-model.ts',
    "export const load = (): Promise<unknown> => import('@huggingface/transformers');\n",
  ],
  [
    'a static import in chat-model.ts',
    'chat-model.ts',
    "import { env } from '@huggingface/transformers';\nexport { env };\n",
  ],
  [
    'a library subpath in runtime.ts',
    'runtime.ts',
    "export const load = (): Promise<unknown> => import('@huggingface/transformers/dist/x.js');\n",
  ],
  [
    'onnxruntime-web imported from runtime.ts',
    'runtime.ts',
    "export const load = (): Promise<unknown> => import('onnxruntime-web');\n",
  ],
])('%s fails', (_label, file, source) => {
  const result = run({ [`${TRANSFORMERS}/${file}`]: source });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${TRANSFORMERS}/${file}: forbidden models import`);
});

test('the runtime file may import the structured-output package dynamically and without types', () => {
  const result = run({
    [`${TRANSFORMERS}/runtime.ts`]:
      "export const load = (): Promise<unknown> => import('@huggingface/transformers-structured-output');\n",
  });
  expect(result).toMatchObject({ status: 0, output: '' });
});

test.each([
  [
    'a static import in runtime.ts',
    'runtime.ts',
    "import { StructuredOutputProcessor } from '@huggingface/transformers-structured-output';\nexport { StructuredOutputProcessor };\n",
  ],
  [
    'a dynamic import in chat-model.ts',
    'chat-model.ts',
    "export const load = (): Promise<unknown> => import('@huggingface/transformers-structured-output');\n",
  ],
])('the structured-output package: %s fails', (_label, file, source) => {
  const result = run({ [`${TRANSFORMERS}/${file}`]: source });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${TRANSFORMERS}/${file}: forbidden models import`);
});

test('the Transformers.js files may import relative files and LangChain core', () => {
  const result = run({
    [`${TRANSFORMERS}/chat-model.ts`]: [adk('./engine.js'), adk('@langchain/core/messages')].join(
      '',
    ),
  });
  expect(result).toMatchObject({ status: 0, output: '' });
});

test.each([
  ['the peer is missing', modelsPackage(WEBLLM, ['@mlc-ai/web-llm'])],
  [
    'the peer is not optional',
    modelsPackage({ ...WEBLLM, '@huggingface/transformers': '4.3.1' }, ['@mlc-ai/web-llm']),
  ],
  [
    'the peer is not exactly 4.3.1',
    modelsPackage({ ...WEBLLM, '@huggingface/transformers': '^4.3.1' }, [
      '@mlc-ai/web-llm',
      '@huggingface/transformers',
    ]),
  ],
  [
    'the structured-output peer is missing',
    modelsPackage({ ...WEBLLM, '@huggingface/transformers': '4.3.1' }, [
      '@mlc-ai/web-llm',
      '@huggingface/transformers',
    ]),
  ],
  [
    'the structured-output peer is not optional',
    modelsPackage(
      {
        ...WEBLLM,
        '@huggingface/transformers': '4.3.1',
        '@huggingface/transformers-structured-output': '4.3.1',
      },
      ['@mlc-ai/web-llm', '@huggingface/transformers'],
    ),
  ],
  [
    'the structured-output peer is not exactly 4.3.1',
    modelsPackage(
      {
        ...WEBLLM,
        '@huggingface/transformers': '4.3.1',
        '@huggingface/transformers-structured-output': '^4.3.1',
      },
      [
        '@mlc-ai/web-llm',
        '@huggingface/transformers',
        '@huggingface/transformers-structured-output',
      ],
    ),
  ],
])('the models peer rule fails when %s', (_label, manifest) => {
  const result = run({ 'packages/models/package.json': manifest });
  expect(result.status).toBe(1);
  expect(result.output).toContain('models peers must be @langchain/core');
});
