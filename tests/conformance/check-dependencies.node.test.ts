// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
    'adapter-go',
    'models',
    'react',
    'storage-indexeddb',
    'tools-mcp',
  ].map((name) => `packages/${name}/dist`),
];

/** The part of pnpm-lock.yaml that records what the pinned Transformers.js depends on. */
const lockfile = (onnxRuntime: string): string =>
  [
    'snapshots:',
    '',
    "  '@huggingface/transformers@4.3.2(@types/node@24.19.2)':",
    '    dependencies:',
    '      sharp: 0.35.4',
    `      onnxruntime-web: ${onnxRuntime}`,
    '',
  ].join('\n');

const FILES: Record<string, string> = {
  'packages/core/package.json': JSON.stringify({
    peerDependencies: { '@opentelemetry/api': '1', zod: '4' },
  }),
  'packages/models/package.json': JSON.stringify({
    peerDependencies: {
      '@huggingface/transformers': '4.3.2',
      '@huggingface/transformers-structured-output': '4.3.2',
      '@langchain/core': '1',
      '@langchain/openai': '1.6.3',
      '@mlc-ai/web-llm': '0.2.86',
    },
    devDependencies: { 'onnxruntime-web': '1.31.0-dev.1' },
    peerDependenciesMeta: {
      '@huggingface/transformers': { optional: true },
      '@huggingface/transformers-structured-output': { optional: true },
      '@langchain/openai': { optional: true },
      '@mlc-ai/web-llm': { optional: true },
    },
  }),
  'pnpm-lock.yaml': lockfile('1.31.0-dev.1'),
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

test('recipe authoring may import the ADK root specifier', () => {
  expect(
    run({ 'examples/adk-recipes/src/recipes/financial/agent.ts': adk('@google/adk') }),
  ).toMatchObject({ status: 0, output: '' });
});

test.each([
  ['examples/adk-recipes/src/host/runtime.ts', '@google/adk'],
  ['examples/adk-recipes/src/recipes-other/agent.ts', '@google/adk'],
  ['examples/adk-recipes/test/agent.test.ts', '@google/adk'],
  ['examples/adk-recipes/src/recipes/financial/agent.ts', '@google/adk/tools/mcp'],
])('recipe imports stay confined at %s', (path, specifier) => {
  const result = run({ [path]: adk(specifier) });
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${path}: ADK imports belong only in packages/adapter-adk`);
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
    modelsPackage({ ...WEBLLM, '@huggingface/transformers': '4.3.2' }, ['@mlc-ai/web-llm']),
  ],
  [
    'the peer is not exactly 4.3.2',
    modelsPackage({ ...WEBLLM, '@huggingface/transformers': '^4.3.2' }, [
      '@mlc-ai/web-llm',
      '@huggingface/transformers',
    ]),
  ],
  [
    'the structured-output peer is missing',
    modelsPackage({ ...WEBLLM, '@huggingface/transformers': '4.3.2' }, [
      '@mlc-ai/web-llm',
      '@huggingface/transformers',
    ]),
  ],
  [
    'the structured-output peer is not optional',
    modelsPackage(
      {
        ...WEBLLM,
        '@huggingface/transformers': '4.3.2',
        '@huggingface/transformers-structured-output': '4.3.2',
      },
      ['@mlc-ai/web-llm', '@huggingface/transformers'],
    ),
  ],
  [
    'the structured-output peer is not exactly 4.3.2',
    modelsPackage(
      {
        ...WEBLLM,
        '@huggingface/transformers': '4.3.2',
        '@huggingface/transformers-structured-output': '^4.3.2',
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

test('the Go adapter may import core, LangChain core and relative files', () => {
  const result = run({
    'packages/adapter-go/src/a.ts': [
      adk('@galaxie/core'),
      adk('@langchain/core/messages'),
      adk('./b.js'),
    ].join(''),
  });
  expect(result).toMatchObject({ status: 0, output: '' });
});

test.each([
  '@galaxie/adapter-langgraph',
  '@galaxie/adapter-pyodide',
  '@galaxie/adapter-adk',
  '@langchain/langgraph/web',
  '@google/adk',
  'pyodide',
])('the Go adapter importing %s fails', (specifier) => {
  const result = run({ 'packages/adapter-go/src/a.ts': adk(specifier) });
  expect(result.status).toBe(1);
  expect(result.output).toContain(
    'the Go adapter must not depend on another executor or framework',
  );
});

test('the Go adapter rejects other packages and relative reaches into adapters', () => {
  const other = run({ 'packages/adapter-go/src/a.ts': adk('left-pad') });
  expect(other.status).toBe(1);
  expect(other.output).toContain('forbidden Go adapter import left-pad');
  const relative = run({ 'packages/adapter-go/src/a.ts': adk('../../adapter-adk/src/index.js') });
  expect(relative.status).toBe(1);
  expect(relative.output).toContain('reaches into a dependency or another adapter');
});

test('node and test tooling are allowed only in Go adapter tests, and never in built output', () => {
  expect(run({ 'packages/adapter-go/src/a.ts': adk('node:fs') }).status).toBe(1);
  expect(run({ 'packages/adapter-go/test/a.ts': adk('node:fs') }).status).toBe(0);
  const built = run({ 'packages/adapter-go/dist/a.js': adk('node:fs') });
  expect(built.status).toBe(1);
  expect(built.output).toContain('built packages must not import node:fs');
});

test('syscall/js belongs only in the bridge package and the gate', () => {
  const source = (name: string): string =>
    `package ${name}\n\nimport "syscall/js"\n\nvar _ = js.Undefined\n`;
  expect(
    run({
      'go/gate/main.go': source('main'),
      'go/galaxie/bridge/bridge.go': source('bridge'),
    }),
  ).toMatchObject({ status: 0, output: '' });
  for (const path of [
    'go/galaxie/agent.go',
    'go/conformance/main.go',
    'go/galaxie/bridge/deep/a.go',
  ]) {
    const result = run({ [path]: source('x') });
    expect(result.status, path).toBe(1);
    expect(result.output).toContain(
      `${path}: syscall/js belongs only in go/galaxie/bridge and go/gate`,
    );
  }
  const forms = [
    'package x\n\nimport (\n\tj "syscall/js"\n)\n',
    'package x\n\nimport ("syscall/js")\n',
    'package x\n\nimport ("fmt"; "syscall/js")\n',
    'package x\n\nimport `syscall/js`\n',
    'package x\n\nimport _ "syscall/js"\n',
    'package x\n\nimport (\n\t"fmt"\n\t. "syscall/js"\n)\n',
  ];
  for (const form of forms) expect(run({ 'go/galaxie/agent.go': form }).status, form).toBe(1);
  // A comment or a string that only mentions the package is not an import.
  const mentions = [
    'package x\n\n// import "syscall/js" is forbidden here\nvar _ = 1\n',
    'package x\n\n/* import (\n"syscall/js"\n) */\nvar _ = 1\n',
    'package x\n\nvar _ = "syscall/js"\n',
  ];
  for (const text of mentions) expect(run({ 'go/galaxie/agent.go': text }).status, text).toBe(0);
}, 60000);

test('the hand-pinned ONNX Runtime must equal the one the pinned Transformers.js declares', () => {
  const result = run({ 'pnpm-lock.yaml': lockfile('1.31.0-dev.2') });
  expect(result.status).toBe(1);
  expect(result.output).toContain('onnxruntime-web must equal 1.31.0-dev.2, found 1.31.0-dev.1');
});
