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
  'templates',
  'tests/conformance',
  'scripts',
  ...[
    'core',
    'adapter-kit',
    'ui-protocol',
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
    dependencies: { '@galaxie/ui-protocol': 'workspace:*' },
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

test.each([
  'export const page = navigator;',
  'export const page = globalThis.navigator;',
  "export const page = globalThis['navigator'];",
  'export const page = globalThis.navigator?.storage;',
  'export const page = document;',
  'export const page = window;',
  'export const page = BroadcastChannel;',
  "export const page = typeof document === 'undefined';",
])('core rejects a module-load browser reference: %s', (source) => {
  const result = run({ 'packages/core/src/page.ts': source });
  expect(result.status).toBe(1);
  expect(result.output).toContain('packages/core/src/page.ts: browser global');
  expect(result.output).toContain('must be guarded inside a function');
});

test.each([
  "export function page() { return document.createElement('div'); }",
  'export const page = () => navigator?.storage;',
  "export const page = () => globalThis.document.createElement('div');",
  "export function page() { document.createElement('div'); if (typeof document === 'undefined') return; }",
  "function guard() { if (typeof document === 'undefined') return; } export const page = () => document.title;",
  "export function page() { if (typeof document === 'undefined') return; return () => document.title; }",
])('core rejects an unguarded function browser reference: %s', (source) => {
  const result = run({ 'packages/core/src/page.ts': source });
  expect(result.status).toBe(1);
  expect(result.output).toContain('packages/core/src/page.ts: browser global');
});

test('core permits guarded router and development shapes', () => {
  expect(
    run({
      'packages/core/src/model-router.ts':
        'export const persist = () => Promise.resolve().then(() => globalThis.navigator?.storage?.persist?.());',
      'packages/core/src/development.ts': [
        'export function warn() {',
        "  try { if (typeof document === 'undefined') return; } catch { return; }",
        "  document.createElement('template');",
        '  return [globalThis.localStorage, globalThis.sessionStorage];',
        '}',
      ].join('\n'),
    }),
  ).toMatchObject({ status: 0, output: '' });
});

test('core permits checked globals and ignores types and property names', () => {
  expect(
    run({
      'packages/core/src/page.ts': [
        'export interface Options { document?: Document; window?: Window }',
        "export const options = { navigator: 'host', BroadcastChannel: 'host' };",
        'export function page() {',
        "  if (typeof navigator === 'undefined') return;",
        '  return navigator.storage;',
        '}',
        'export function channel() {',
        "  if (typeof BroadcastChannel !== 'undefined') return new BroadcastChannel('app');",
        '}',
      ].join('\n'),
    }),
  ).toMatchObject({ status: 0, output: '' });
});

test.each(['browser', 'ownership', 'invalidation'])(
  'main-entry modules cannot import or re-export %s',
  (module) => {
    for (const source of [
      `export * from './${module}.js';`,
      `export type { Options } from './${module}.js';`,
      `import './${module}.js';`,
      `export const load = () => import('./${module}.js');`,
    ]) {
      const result = run({ 'packages/core/src/index.ts': source });
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        `packages/core/src/index.ts: main-entry modules must not import or re-export ./${module}.js`,
      );
    }
    const indirect = run({
      'packages/core/src/helper.ts': `export * from './${module}.js';`,
    });
    expect(indirect.status).toBe(1);
    expect(indirect.output).toContain('packages/core/src/helper.ts: main-entry modules must not');
  },
);

test('the browser entry composes ownership and invalidation modules', () => {
  expect(
    run({
      'packages/core/src/browser.ts':
        "export * from './ownership.js';\nexport * from './invalidation.js';",
    }),
  ).toMatchObject({ status: 0, output: '' });
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

const EXECUTOR_ADAPTERS = ['adapter-langgraph', 'adapter-pyodide', 'adapter-adk', 'adapter-go'];
const ADAPTER_AREAS = ['src', 'dist', 'test'];

test.each(EXECUTOR_ADAPTERS)(
  '%s may import the adapter-kit public root in source, build and tests',
  (adapter) => {
    const extra = Object.fromEntries(
      ADAPTER_AREAS.map((area) => [
        `packages/${adapter}/${area}/kit.${area === 'dist' ? 'js' : 'ts'}`,
        adk('@galaxie/adapter-kit'),
      ]),
    );
    expect(run(extra)).toMatchObject({ status: 0, output: '' });
  },
);

test.each(EXECUTOR_ADAPTERS.flatMap((adapter) => ADAPTER_AREAS.map((area) => [adapter, area])))(
  '%s/%s may not reach into kit subpaths or relative internals',
  (adapter, area) => {
    const extension = area === 'dist' ? 'js' : 'ts';
    const extra = {
      [`packages/${adapter}/${area}/subpath.${extension}`]: adk('@galaxie/adapter-kit/tool-calls'),
      [`packages/${adapter}/${area}/relative.${extension}`]: adk('../../adapter-kit/src/index.js'),
      [`packages/${adapter}/${area}/relative-dist.${extension}`]: adk(
        '../../adapter-kit/dist/index.js',
      ),
    };
    const result = run(extra);
    expect(result.status).toBe(1);
    for (const file of Object.keys(extra))
      expect(result.output).toContain(`${file}: adapter-kit imports must use the public root`);
  },
);

test.each(
  EXECUTOR_ADAPTERS.flatMap((adapter) =>
    ADAPTER_AREAS.flatMap((area) =>
      EXECUTOR_ADAPTERS.filter((other) => other !== adapter).map((other) => [adapter, area, other]),
    ),
  ),
)('%s/%s may not import %s by package, subpath or relative path', (adapter, area, other) => {
  const extension = area === 'dist' ? 'js' : 'ts';
  const extra = {
    [`packages/${adapter}/${area}/package.${extension}`]: adk(`@galaxie/${other}`),
    [`packages/${adapter}/${area}/subpath.${extension}`]: adk(`@galaxie/${other}/internal`),
    [`packages/${adapter}/${area}/relative.${extension}`]: adk(`../../${other}/src/index.js`),
  };
  const result = run(extra);
  expect(result.status).toBe(1);
  for (const file of Object.keys(extra)) expect(result.output).toContain(`${file}:`);
  expect(result.output).toContain('must not depend on another executor');
  expect(result.output).toContain('reaches into a dependency or another adapter');
});

test.each(['src/allowed.ts', 'dist/allowed.d.ts'])(
  'adapter-kit %s permits core public exports, erased LangChain types and kit-relative files',
  (path) => {
    expect(
      run({
        [`packages/adapter-kit/${path}`]: [
          adk('@galaxie/core'),
          adk('@langchain/core', 'type'),
          adk('@langchain/core/messages', 'type'),
          "export type { BaseMessage } from '@langchain/core/messages';\n",
          "type Message = import('@langchain/core/messages').BaseMessage;\n",
          adk('./local.js'),
        ].join(''),
      }),
    ).toMatchObject({ status: 0, output: '' });
  },
);

test.each(ADAPTER_AREAS)('adapter-kit %s may never import an executor adapter', (area) => {
  const extension = area === 'dist' ? 'js' : 'ts';
  const extra = Object.fromEntries(
    EXECUTOR_ADAPTERS.flatMap((adapter) => [
      [`packages/adapter-kit/${area}/${adapter}.${extension}`, adk(`@galaxie/${adapter}`)],
      [
        `packages/adapter-kit/${area}/${adapter}-subpath.${extension}`,
        adk(`@galaxie/${adapter}/internal`),
      ],
      [
        `packages/adapter-kit/${area}/${adapter}-relative.${extension}`,
        adk(`../../${adapter}/src/index.js`),
      ],
    ]),
  );
  const result = run(extra);
  expect(result.status).toBe(1);
  for (const file of Object.keys(extra))
    expect(result.output).toContain(`${file}: forbidden adapter-kit import`);
});

test.each([
  '@galaxie/core/internal',
  '../../core/src/index.js',
  '../../core/dist/index.js',
  '../../models/src/mock.js',
  '../node_modules/@langchain/core/messages.js',
  '../../../../outside.js',
  '@google/adk',
  'pyodide',
  'react',
  'node:fs',
  'fs',
  'left-pad',
])('adapter-kit production rejects %s', (specifier) => {
  for (const path of ['src/a.ts', 'dist/a.js']) {
    const result = run({ [`packages/adapter-kit/${path}`]: adk(specifier) });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`packages/adapter-kit/${path}: forbidden adapter-kit import`);
  }
});

test.each([
  "import { BaseMessage } from '@langchain/core/messages';\n",
  "import '@langchain/core/messages';\n",
  "export { BaseMessage } from '@langchain/core/messages';\n",
  "export * from '@langchain/core/messages';\n",
  "const module = import('@langchain/core/messages');\n",
  "import { type BaseMessage } from '@langchain/core/messages';\n",
  "export { type BaseMessage } from '@langchain/core/messages';\n",
])('adapter-kit rejects runtime LangChain references: %s', (source) => {
  for (const path of ['src/a.ts', 'dist/a.js']) {
    const result = run({ [`packages/adapter-kit/${path}`]: source });
    expect(result.status).toBe(1);
    expect(result.output).toContain('forbidden adapter-kit import @langchain/core/messages');
  }
});

test.each([
  "import models = require('@langchain/core/messages');\n",
  "const models = require('@langchain/core/messages');\n",
])('adapter-kit rejects CommonJS loads: %s', (source) => {
  const result = run({ 'packages/adapter-kit/src/a.ts': source });
  expect(result.status).toBe(1);
  expect(result.output).toContain('CommonJS loads are not allowed');
});

test('test tooling, runtime message fixtures and shared conformance support stay test-only in adapter-kit', () => {
  const source = [
    adk('vitest'),
    adk('node:fs'),
    adk('@langchain/core/messages'),
    adk('../../../tests/conformance/support/tool-call-checks.js'),
  ].join('');
  expect(run({ 'packages/adapter-kit/test/a.test.ts': source })).toMatchObject({
    status: 0,
    output: '',
  });
  const production = run({ 'packages/adapter-kit/src/a.ts': source });
  expect(production.status).toBe(1);
  for (const specifier of [
    'vitest',
    'node:fs',
    '@langchain/core/messages',
    '../../../tests/conformance/support/tool-call-checks.js',
  ])
    expect(production.output).toContain(`forbidden adapter-kit import ${specifier}`);
});

test('the built adapter-kit rejects Node imports and async_hooks', () => {
  const node = run({ 'packages/adapter-kit/dist/a.js': adk('node:fs') });
  expect(node.status).toBe(1);
  expect(node.output).toContain('built packages must not import node:fs');
  const hooks = run({ 'packages/adapter-kit/dist/a.js': '// async_hooks\n' });
  expect(hooks.status).toBe(1);
  expect(hooks.output).toContain('built packages must not contain async_hooks');
});

test.each(['src/a.ts', 'dist/a.js', 'test/a.test.ts'])(
  'ui-protocol %s permits only its own relative files and test tooling',
  (path) => {
    const source = adk('../src/local.js') + (path.startsWith('test/') ? adk('vitest') : '');
    expect(run({ [`packages/ui-protocol/${path}`]: source })).toMatchObject({
      status: 0,
      output: '',
    });
  },
);

test.each([
  '@galaxie/core',
  '@galaxie/react',
  '@galaxie/adapter-kit',
  'react',
  'react-dom',
  'node:fs',
  'fs',
  'path',
  'left-pad',
  '../../core/src/index.js',
  '../node_modules/a.js',
  '../../../../outside.js',
])('ui-protocol rejects dependency %s in source, output and browser tests', (specifier) => {
  for (const path of ['src/a.ts', 'dist/a.js', 'test/a.test.ts']) {
    const result = run({ [`packages/ui-protocol/${path}`]: adk(specifier) });
    expect(result.status).toBe(1);
    expect(result.output).toContain(`packages/ui-protocol/${path}: forbidden ui-protocol import`);
  }
});

test('ui-protocol fixture inspection is Node-test-only', () => {
  expect(run({ 'packages/ui-protocol/test/a.node.test.ts': adk('node:fs') })).toMatchObject({
    status: 0,
    output: '',
  });
});

test.each([
  'document.title',
  'window.location',
  'new Worker("a")',
  'globalThis.document',
  'globalThis["Worker"]',
  'navigator',
  'setTimeout(() => {}, 1)',
])('ui-protocol source and output reject platform access: %s', (source) => {
  for (const path of ['src/a.ts', 'dist/a.js']) {
    const result = run({ [`packages/ui-protocol/${path}`]: `export const value = ${source};` });
    expect(result.status).toBe(1);
    expect(result.output).toContain('ui-protocol must not use platform globals');
  }
});

test.each([
  '@galaxie/ui-protocol/internal',
  '@galaxie/ui-protocol/src/index.js',
  '@galaxie/ui-protocol/dist/index.js',
  '../../ui-protocol/src/index.js',
  '../../ui-protocol/dist/index.js',
])('consumers must use the ui-protocol public root: %s', (specifier) => {
  const result = run({ 'packages/adapter-langgraph/src/protocol.ts': adk(specifier) });
  expect(result.status).toBe(1);
  expect(result.output).toContain('ui-protocol imports must use the public root');
});

test.each(['packages/react/src/a.ts'])(
  'existing consumer allowlists do not yet permit ui-protocol: %s',
  (path) => {
    expect(run({ [path]: adk('@galaxie/ui-protocol') }).status).toBe(1);
  },
);

test('the protocol public-root inventory preserves unrelated tooling import behavior', () => {
  expect(
    run({ 'scripts/manifest.ts': "const moduleName = 'host'; await import(moduleName);" }),
  ).toMatchObject({ status: 0, output: '' });
  const result = run({ 'scripts/protocol.ts': adk('@galaxie/ui-protocol/src/index.js') });
  expect(result.status).toBe(1);
  expect(result.output).toContain('ui-protocol imports must use the public root');
});

test('core declares exactly the protocol dependency and may import its public root', () => {
  expect(run({ 'packages/core/src/surface.ts': adk('@galaxie/ui-protocol') })).toMatchObject({
    status: 0,
    output: '',
  });
});

test.each([{}, { 'left-pad': '1' }, { '@galaxie/ui-protocol': 'workspace:*', 'left-pad': '1' }])(
  'core rejects a dependency set other than the protocol package: %j',
  (dependencies) => {
    const manifest = JSON.stringify({
      dependencies,
      peerDependencies: { '@opentelemetry/api': '1', zod: '4' },
    });
    const result = run({ 'packages/core/package.json': manifest });
    expect(result.status).toBe(1);
    expect(result.output).toContain('core dependencies must be exactly @galaxie/ui-protocol');
  },
);

test.each(['@galaxie/ui-protocol/internal', '../../ui-protocol/src/index.js', 'left-pad'])(
  'core rejects non-root protocol or other imports: %s',
  (specifier) => {
    const result = run({ 'packages/core/src/surface.ts': adk(specifier) });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      specifier === 'left-pad'
        ? 'forbidden core import left-pad'
        : 'ui-protocol imports must use the public root',
    );
  },
);
