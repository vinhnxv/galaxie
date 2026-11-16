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
    'adk-js.dependencies.zod',
    'langgraph-js.dependencies.zod',
  ]);
  expect(mismatchedPins(layers, { ...pins, react: '*' })).toEqual(['base.dependencies.react']);
  const rendererPins = renderer['devDependencies'] as JsonObject;
  for (const name of ['react', '@types/react']) expect(pins[name], name).toBe(rendererPins[name]);
  expect(create).toMatchObject({
    name: '@galaxie-ai/create',
    private: true,
    version: '0.0.0',
    type: 'module',
    license: 'Apache-2.0',
    engines: { node: '>=22.22.2' },
    bin: { create: 'dist/cli.js' },
  });
  expect(create['dependencies']).toBeUndefined();
});

test('both kinds share agent bytes and preserve the original CSP source hashes', async () => {
  const layers = await loadLayers(templates);
  const browser = compose(layers, { ...options, kind: 'browser-only' });
  const gateway = compose(layers, { ...options, kind: 'gateway' });
  expect(browser.files.get('src/agent.ts')?.bytes).toEqual(
    gateway.files.get('src/agent.ts')?.bytes,
  );
  for (const [project, expected] of [
    [browser, '05dbd8eee1c3a95ea1a4b223eb17fd99a7148a9bdebc560f4f670cd5133ebf79'],
    [gateway, '6ca810a0c86df49ee16df1e6d7e3f958e441f123affa72cd6b31377bd75e827f'],
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
    'src/main.tsx',
    'src/runtime.ts',
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
    '@galaxie-ai/adapter-adk': '^0.1.0',
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
