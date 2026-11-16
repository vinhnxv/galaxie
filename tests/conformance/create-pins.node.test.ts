// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { compose } from '../../packages/create/src/compose.js';
import { type Layer, loadLayers } from '../../packages/create/src/layers.js';
import type { JsonObject } from '../../packages/create/src/merge.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const templates = fileURLToPath(new URL('../../templates/', import.meta.url));
const options = {
  framework: 'langgraph-js',
  name: 'example-app',
  mode: 'project',
  packageManager: 'npm',
} as const;
async function manifest(path: string): Promise<JsonObject> {
  return JSON.parse(
    await readFile(new URL('../../' + path + '/package.json', import.meta.url), 'utf8'),
  ) as JsonObject;
}

const coreVersion = (await manifest('packages/core'))['version'] as string;

test('every galaxie layer pin matches its package manifest caret range', async () => {
  const layers = await loadLayers(templates);
  const pins: string[] = [];
  for (const layer of layers)
    for (const section of ['dependencies', 'devDependencies'])
      for (const [name, range] of Object.entries(
        (layer.manifest.package[section] ?? {}) as JsonObject,
      )) {
        if (!name.startsWith('@galaxie-ai/')) continue;
        const pkg = await manifest(`packages/${name.slice('@galaxie-ai/'.length)}`);
        expect(range, `${layer.manifest.id}.${section}.${name}`).toBe(`^${pkg['version']}`);
        pins.push(name);
      }
  expect(pins).toHaveLength(10);
});

function mismatchedPins(layers: readonly Layer[], pins: JsonObject): string[] {
  const problems: string[] = [];
  for (const layer of layers)
    for (const section of ['dependencies', 'devDependencies']) {
      for (const [name, version] of Object.entries(
        (layer.manifest.package[section] ?? {}) as JsonObject,
      )) {
        if (name.startsWith('@galaxie-ai/')) continue;
        if (
          typeof version !== 'string' ||
          !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ||
          pins[name] !== version
        )
          problems.push(`${layer.manifest.id}.${section}.${name}`);
      }
    }
  return problems;
}

test('layer third-party pins equal create tooling and share React with the renderer', async () => {
  const layers = await loadLayers(templates);
  const create = await manifest('packages/create');
  const renderer = await manifest('packages/react');
  const pins = create['devDependencies'] as JsonObject;
  expect(mismatchedPins(layers, pins)).toEqual([]);
  expect(mismatchedPins(layers, { ...pins, zod: '0.0.0' })).toEqual([
    'adk-go.dependencies.zod',
    'adk-js.dependencies.zod',
    'langgraph-js.dependencies.zod',
    'langgraph-python.dependencies.zod',
  ]);
  expect(mismatchedPins(layers, { ...pins, react: '*' })).toEqual(['base.dependencies.react']);
  const rendererPins = renderer['devDependencies'] as JsonObject;
  for (const name of ['react', '@types/react']) expect(pins[name], name).toBe(rendererPins[name]);
  expect(create).toMatchObject({
    name: '@galaxie-ai/create',
    version: coreVersion,
    type: 'module',
    license: 'Apache-2.0',
    engines: { node: '>=22.22.2' },
    bin: { create: 'dist/cli.js' },
  });
  expect(create).not.toHaveProperty('private');
  expect(create['dependencies']).toBeUndefined();
});

test('both kinds share agent bytes and pin the framework-aware CSP source hashes', async () => {
  const layers = await loadLayers(templates);
  const browser = compose(layers, { ...options, kind: 'browser-only' });
  const gateway = compose(layers, { ...options, kind: 'gateway' });
  expect(browser.files.get('src/agent.ts')?.bytes).toEqual(
    gateway.files.get('src/agent.ts')?.bytes,
  );
  for (const [project, expected] of [
    [browser, '2b01b35320287590ece2b2c94d3bb3d1084977da174f3c2306367322b8dc90b1'],
    [gateway, '227f70a6698827e541f0d634667aa223617104eba67c8bee020ff8e213ed5477'],
  ] as const) {
    const source = project.files.get('src/csp.ts');
    expect(source).toBeDefined();
    expect(
      createHash('sha256')
        .update(source?.bytes ?? new Uint8Array())
        .digest('hex'),
    ).toBe(expected);
    expect(project.files.has('.gitignore')).toBe(true);
    expect(project.files.has('tsconfig.workspace.json')).toBe(false);
    expect([...project.files.keys()].some((path) => path.startsWith('test/'))).toBe(false);
    const pkg = JSON.parse(
      Buffer.from(project.files.get('package.json')?.bytes ?? []).toString(),
    ) as JsonObject;
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
    expect(Object.keys(pkg)).toEqual([
      'name',
      'version',
      'private',
      'description',
      'license',
      'type',
      'engines',
      'scripts',
      'dependencies',
      'devDependencies',
    ]);
    expect(Object.keys(pkg['dependencies'] as JsonObject)).toEqual(
      Object.keys(pkg['dependencies'] as JsonObject).sort(),
    );
  }
  const common = [
    '.gitignore',
    'README.md',
    'check/baseline.check.ts',
    'check/tsconfig.json',
    'index.html',
    'package.json',
    'src/agent.ts',
    'src/app.tsx',
    'src/csp.ts',
    'src/executor.ts',
    'src/framework-profile.ts',
    'src/main.tsx',
    'src/runtime.ts',
    'src/worker-policy.ts',
    'tsconfig.json',
    'vite.config.ts',
    'vite.framework.ts',
  ];
  expect([...browser.files.keys()]).toEqual(
    [...common, 'src/model-state.ts', 'src/webllm.ts', 'src/webllm-worker.ts'].sort(),
  );
  expect([...gateway.files.keys()]).toEqual(
    [
      ...common,
      'public/favicon.svg',
      'server/dev.ts',
      'server/gateway.ts',
      'server/mock-upstream.ts',
      'server/plugin.ts',
      'server/serve.ts',
      'server/tsconfig.json',
      'src/gateway-state.ts',
      'src/model-fetch.ts',
      'src/session.ts',
    ].sort(),
  );
  const workspace = compose(layers, {
    ...options,
    kind: 'browser-only',
    mode: 'workspace-test',
    workspaceRoot: repo,
  });
  expect(workspace.files.has('test/app.test.ts')).toBe(true);
});

test('the ADK starter callback pauses before inference and resumes to the model reply', async () => {
  const { createRuntime } = await import('@galaxie-ai/core');
  const {
    createExecutor,
    createMockModel,
    createServices,
    createTemplateAgent,
    templateDefinition,
    starterInput,
    readResult,
    mockReply,
    providerDescriptor,
    starterBindings,
  } = await import(
    new URL(
      '../../packages/create/.cache/composed/browser-only-adk-js/src/executor.ts',
      import.meta.url,
    ).href
  );
  const model = createMockModel();
  const runtime = createRuntime({ appId: 'adk-starter-test', executors: [createExecutor()] });
  try {
    const instance = await runtime.create(templateDefinition, {
      principalScope: 'test',
      agent: createTemplateAgent(),
      services: createServices({ mock: model }),
      models: {
        providers: {
          mock: providerDescriptor({
            destination: 'in-browser',
            modality: 'text',
            languages: ['en'],
            features: ['streaming', 'cancellation'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          }),
        },
        roles: { comment: { providers: ['mock'], allow: ['in-browser'], maxTokens: 48 } },
      },
      bindings: starterBindings,
    });
    await instance.prepare();
    const { runId } = await instance.start(starterInput);
    await expect.poll(() => instance.getSnapshot().run?.status).toBe('waiting_input');
    const pending = instance.getSnapshot().run?.pending;
    expect(pending).toMatchObject({ surfaceId: 'question', viewRevision: 'question-v1' });
    expect(model.calls).toBe(0);
    if (pending === undefined) throw new Error('The question did not pause.');
    expect(
      await instance.dispatch({
        ...pending,
        instanceId: instance.instanceId,
        runId,
        action: 'submit',
        payload: { answers: { sum: 'four' } },
      }),
    ).toMatchObject({ status: 'accepted' });
    await expect.poll(() => instance.getSnapshot().run?.status).toBe('succeeded');
    const outputs: unknown[] = [];
    for await (const event of instance.events(runId))
      if (event.type === 'output') outputs.push(event.output);
    expect(outputs.map(readResult)).toEqual([mockReply]);
    expect(model.calls).toBe(1);
  } finally {
    await runtime.dispose();
  }
});

test('the ADK overlay preserves inventories, pins, initialization and kind neutrality', async () => {
  const layers = await loadLayers(templates);
  const framework = layers.find((layer) => layer.manifest.id === 'adk-js');
  expect(framework?.manifest.package['dependencies']).toEqual({
    '@galaxie-ai/adapter-adk': `^${coreVersion}`,
    '@google/adk': '2.3.0',
    '@langchain/core': '1.2.20',
    zod: '4.6.7',
  });
  const agentBytes: Uint8Array[] = [];
  for (const kind of ['browser-only', 'gateway']) {
    const original = compose(layers, { ...options, kind });
    const project = compose(layers, { ...options, kind, framework: 'adk-js' });
    expect([...project.files.keys()]).toEqual([...original.files.keys(), 'src/adk-env.ts'].sort());
    expect(project.files.get('src/csp.ts')?.bytes).toEqual(original.files.get('src/csp.ts')?.bytes);
    agentBytes.push(project.files.get('src/agent.ts')?.bytes ?? new Uint8Array());
    const env = Buffer.from(project.files.get('src/adk-env.ts')?.bytes ?? []).toString();
    // The runtime environment guard and jitless zod must run before the adapter is imported.
    expect(env).toMatch(
      /z\.config\(\{ jitless: true \}\);\s*const \{ ensureAdkRuntimeEnv \} = await import\('@galaxie-ai\/adapter-adk'\);\s*ensureAdkRuntimeEnv\(\);/,
    );
    // The build-time control keeps prompts and replies out of ADK spans.
    const viteFramework = Buffer.from(
      project.files.get('vite.framework.ts')?.bytes ?? [],
    ).toString();
    expect(viteFramework).toContain(
      "'process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS': '\"false\"'",
    );
    const executor = Buffer.from(project.files.get('src/executor.ts')?.bytes ?? []).toString();
    expect(executor.replace(/^\/\/.*\n/gm, '').trimStart()).toMatch(/^import '\.\/adk-env\.js';/);
    expect(
      executor
        .replace("import './adk-env.js';", '')
        .replace(/^\/\/.*\n/gm, '')
        .trimStart(),
    ).not.toMatch(/^import '\.\/adk-env\.js';/);
  }
  expect(agentBytes[0]).toEqual(agentBytes[1]);
  for (const layer of layers.filter((layer) => layer.manifest.type === 'kind')) {
    for (const [path, bytes] of [...layer.files, ...layer.workspaceFiles]) {
      expect(Buffer.from(bytes).toString(), path).not.toMatch(
        /@google\/adk|@galaxie-ai\/adapter-|@langchain\/langgraph/,
      );
    }
  }
});

test('the ADK overlay refuses a custom BaseAgent at preparation', async () => {
  const { BaseAgent } = await import('@google/adk');
  class Custom extends BaseAgent {
    protected override async *runAsyncImpl(): AsyncGenerator<never, void, void> {}
    protected override async *runLiveImpl(): AsyncGenerator<never, void, void> {}
  }
  const { createRuntime } = await import('@galaxie-ai/core');
  const executor = await import(
    new URL(
      '../../packages/create/.cache/composed/browser-only-adk-js/src/executor.ts',
      import.meta.url,
    ).href
  );
  const runtime = createRuntime({
    appId: 'adk-custom-test',
    executors: [executor.createExecutor()],
  });
  try {
    const instance = await runtime.create(executor.templateDefinition, {
      principalScope: 'test',
      agent: () => new Custom({ name: 'custom' }),
      services: { chatModels: { mock: executor.createMockModel() } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            languages: ['en'],
            features: ['streaming', 'cancellation'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { comment: { providers: ['mock'], allow: ['in-browser'], maxTokens: 48 } },
      },
      bindings: executor.starterBindings,
    });
    await expect(instance.prepare()).rejects.toMatchObject({ code: 'unsupported' });
  } finally {
    await runtime.dispose();
  }
});

test.each([
  ['submit', {}, 'rejected'],
  ['submit', { answers: { sum: 'six' } }, 'accepted'],
  ['approve', { answers: { sum: 'four' } }, 'rejected'],
])('the ADK starter rejects invalid answer or action %s %j', async (action, payload, status) => {
  const { createTemplateHost } = await import(
    new URL(
      '../../packages/create/.cache/composed/browser-only-adk-js/src/runtime.ts',
      import.meta.url,
    ).href
  );
  const { starterInput } = await import(
    new URL(
      '../../packages/create/.cache/composed/browser-only-adk-js/src/executor.ts',
      import.meta.url,
    ).href
  );
  const host = await createTemplateHost({
    builtInAIProbe: async () => 'unavailable',
    webGPUProbe: () => false,
  });
  try {
    const instance = await host.createInstance();
    await instance.prepare();
    const { runId } = await instance.start(starterInput);
    await expect.poll(() => instance.getSnapshot().run?.status).toBe('waiting_input');
    const pending = instance.getSnapshot().run?.pending;
    expect(pending).toBeDefined();
    const receipt = await instance.dispatch({
      ...pending,
      instanceId: instance.instanceId,
      runId,
      action,
      payload,
    });
    expect(receipt).toMatchObject({ status });
    if (status === 'rejected') {
      expect(receipt).toMatchObject({ error: { code: 'invalid' } });
      expect(instance.getSnapshot().run?.status).toBe('waiting_input');
      expect(instance.getSnapshot().run?.pending).toEqual(pending);
    } else {
      await expect.poll(() => instance.getSnapshot().run?.status).toBe('failed');
      expect(instance.getSnapshot().run?.error).toMatchObject({ code: 'invalid' });
    }
  } finally {
    await host.dispose();
  }
});

test.each(['browser-only', 'gateway'])(
  'the %s Go overlay pins both release packages and keeps build plus preview',
  async (kind) => {
    const layers = await loadLayers(templates);
    const framework = layers.find((layer) => layer.manifest.id === 'adk-go');
    expect(framework?.manifest.package['dependencies']).toEqual({
      '@galaxie-ai/adapter-go': `^${coreVersion}`,
      '@galaxie-ai/starter-go': `^${coreVersion}`,
      '@langchain/core': '1.2.20',
      zod: '4.6.7',
    });
    const project = compose(layers, { ...options, kind, framework: 'adk-go' });
    const pkg = JSON.parse(Buffer.from(project.files.get('package.json')?.bytes ?? []).toString());
    expect(pkg.scripts.dev).toBe(
      'vite build && vite preview --host 127.0.0.1 --port 4173 --strictPort',
    );
    expect(project.files.has('GO.md')).toBe(true);
    expect(project.files.has('go/go.mod')).toBe(true);
  },
);

// Captured from main (061d1cd), with reviewed release documentation updates.
const existingOutputHashes: Readonly<Record<string, string>> = {
  'browser-only/langgraph-js/npm':
    '4020ae24a92f26d6b2b15617ad44bcccac5803a3a158bd3d568b22ef406dd27a',
  'browser-only/langgraph-js/pnpm':
    '4020ae24a92f26d6b2b15617ad44bcccac5803a3a158bd3d568b22ef406dd27a',
  'browser-only/langgraph-js/yarn':
    '4020ae24a92f26d6b2b15617ad44bcccac5803a3a158bd3d568b22ef406dd27a',
  'browser-only/adk-js/npm': '281c3a49c6bfbda0186d725133a24c569f1f3d8c922d9294b6d72c68a48f2eab',
  'browser-only/adk-js/pnpm': 'd133cdc029c61682fc0c5c5d21889fd157f64f8e937b2eccfec60b45c86c42fc',
  'browser-only/adk-js/yarn': '281c3a49c6bfbda0186d725133a24c569f1f3d8c922d9294b6d72c68a48f2eab',
  'browser-only/adk-go/npm': 'cf108d9a3b6940ec5701910ad339840ddf0f92d9960431f4823e090d72484480',
  'browser-only/adk-go/pnpm': 'cf108d9a3b6940ec5701910ad339840ddf0f92d9960431f4823e090d72484480',
  'browser-only/adk-go/yarn': 'cf108d9a3b6940ec5701910ad339840ddf0f92d9960431f4823e090d72484480',
  'gateway/langgraph-js/npm': '5f7cdf4f000e613220bb1b42a68c8d76d1a89f9f5c4ef05e8b2f889da5c7ebce',
  'gateway/langgraph-js/pnpm': '5f7cdf4f000e613220bb1b42a68c8d76d1a89f9f5c4ef05e8b2f889da5c7ebce',
  'gateway/langgraph-js/yarn': '5f7cdf4f000e613220bb1b42a68c8d76d1a89f9f5c4ef05e8b2f889da5c7ebce',
  'gateway/adk-js/npm': '301f348568c750df3ba7bbaebf92a1b07ccb6d7d07e26f971b49a94b03d529d8',
  'gateway/adk-js/pnpm': '60bbaaa48f6589461d70a01b00a1936ee21dd76b94956ec133501f610936c717',
  'gateway/adk-js/yarn': '301f348568c750df3ba7bbaebf92a1b07ccb6d7d07e26f971b49a94b03d529d8',
  'gateway/adk-go/npm': 'e39158e2f55a5b6b402380b584f6ac83ccd5ab37fe74993cea684246a2cc2260',
  'gateway/adk-go/pnpm': 'e39158e2f55a5b6b402380b584f6ac83ccd5ab37fe74993cea684246a2cc2260',
  'gateway/adk-go/yarn': 'e39158e2f55a5b6b402380b584f6ac83ccd5ab37fe74993cea684246a2cc2260',
};
test('all existing outputs retain reviewed bytes except the baseline binding and two MIME entries', async () => {
  const layers = await loadLayers(templates);
  for (const [combination, expected] of Object.entries(existingOutputHashes)) {
    const [kind, framework, packageManager] = combination.split('/');
    const { files } = compose(layers, {
      ...options,
      kind: kind as string,
      framework: framework as string,
      packageManager: packageManager as 'npm' | 'pnpm' | 'yarn',
    });
    const hash = createHash('sha256');
    for (const [path, file] of files) {
      if (path === 'check/baseline.check.ts') continue;
      // Keep the captured hashes sensitive to every change except the lockstep range.
      let bytes = file.bytes;
      if (path === 'package.json' || path === 'README.md')
        bytes = Buffer.from(Buffer.from(bytes).toString().replaceAll(`^${coreVersion}`, '^0.1.0'));
      if (path === 'server/serve.ts') {
        let source = Buffer.from(bytes).toString();
        for (const line of [
          "    '.mjs': 'text/javascript; charset=utf-8',\n",
          "    '.wasm': 'application/wasm',\n",
        ]) {
          expect(source.split(line), combination).toHaveLength(2);
          source = source.replace(line, '');
        }
        bytes = Buffer.from(source);
      }
      hash.update(JSON.stringify([path, file.mode, bytes.length]));
      hash.update(bytes);
    }
    expect(hash.digest('hex'), combination).toBe(expected);
  }
});
test.each(['browser-only', 'gateway'])(
  'the %s Python overlay pins its release artifacts and raw sources',
  async (kind) => {
    const layers = await loadLayers(templates);
    const { files } = compose(layers, { ...options, kind, framework: 'langgraph-python' });
    const manifest = JSON.parse(Buffer.from(files.get('package.json')!.bytes).toString());
    expect(manifest.dependencies['@galaxie-ai/adapter-pyodide']).toBe(`^${coreVersion}`);
    expect(manifest.dependencies['@galaxie-ai/starter-python']).toBe(`^${coreVersion}`);
    expect(manifest.dependencies.pyodide).toBe('314.0.7');
    expect(manifest.scripts.dev).toBe(
      'vite build && vite preview --host 127.0.0.1 --port 4173 --strictPort',
    );
    expect([...files.keys()].filter((path) => path.startsWith('python/'))).toEqual([
      'python/agent/starter_agent/__init__.py',
      'python/agent/starter_agent/graph.py',
    ]);
    for (const path of ['src/pyodide-worker.ts', 'src/python-build.d.ts', 'PYTHON.md'])
      expect(files.has(path)).toBe(true);
  },
);
