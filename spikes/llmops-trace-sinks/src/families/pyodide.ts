// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Adapted from examples/rag-browser/test/support/python.node.ts and the inline graphs in
// tests/conformance/pyodide.node.test.ts: built worker imports, OS temp bootstrap and tracing.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideWorkerPort,
} from '@galaxie-ai/adapter-pyodide';
import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { z } from 'zod';
import { createProvider } from './provider.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const defaultCache = join(repository, '.cache/python-wheels');
const entry = new URL(import.meta.resolve('@galaxie-ai/adapter-pyodide'));
const built = dirname(fileURLToPath(entry));
const runtime = join(built, '../node_modules/pyodide');

interface Inventory {
  lockedWheels: PyodideAdapterOptions['localWheels'];
  runtimeFiles: readonly { file: string }[];
}

export interface PyodideUnmeasured {
  measurement: 'unmeasured';
  reason: string;
  probes: string[];
}

export interface PyodideMeasured {
  measurement: 'measured';
  spans: readonly ReadableSpan[];
  modelCalls: number;
  capabilityCalls: number;
  outputCorrect: true;
  versions: Record<string, string>;
}

async function inventory(): Promise<Inventory> {
  return (await import(new URL('./runtime-files.js', entry).href)) as Inventory;
}

export async function probePyodide(
  cacheRoot = defaultCache,
): Promise<{ measurement: 'available'; probes: string[] } | PyodideUnmeasured> {
  const probes: string[] = [];
  const check = (path: string, label: string): boolean => {
    const found = existsSync(path);
    probes.push(`${label}: ${found ? 'present' : 'missing'}`);
    return found;
  };
  const missing: string[] = [];
  const manifest = '.cache/python-wheels/local-wheels.json';
  if (!check(join(cacheRoot, 'local-wheels.json'), manifest))
    return { measurement: 'unmeasured', reason: `${manifest} is missing`, probes };
  for (const name of ['worker.js', 'runtime-files.js']) {
    const label = `packages/adapter-pyodide/dist/${name}`;
    if (!check(join(built, name), label)) missing.push(label);
  }
  if (missing.length)
    return {
      measurement: 'unmeasured',
      reason: `Missing built files: ${missing.join(', ')}`,
      probes,
    };
  const files = await inventory();
  const local = JSON.parse(await readFile(join(cacheRoot, 'local-wheels.json'), 'utf8')) as {
    packages: PyodideAdapterOptions['localWheels'];
  };
  for (const wheel of [...files.lockedWheels, ...local.packages]) {
    const label = `.cache/python-wheels/${wheel.file}`;
    if (!check(join(cacheRoot, wheel.file), label)) missing.push(label);
  }
  for (const file of files.runtimeFiles) {
    const label = `packages/adapter-pyodide/node_modules/pyodide/${file.file}`;
    if (!check(join(runtime, file.file), label)) missing.push(label);
  }
  return missing.length
    ? { measurement: 'unmeasured', reason: `Missing local assets: ${missing.join(', ')}`, probes }
    : { measurement: 'available', probes };
}

const source = `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from langgraph.graph import StateGraph, START, END
from galaxie.langgraph import checkpointer
from galaxie.langchain import GalaxieChatModel
from galaxie.capabilities import call

def create_agent():
    async def respond(state, config):
        reply = await GalaxieChatModel(role='answer').ainvoke('synthetic python prompt', config)
        return {'answer': reply.content}
    async def lookup(state, config):
        result = await call('lookup@1', {'value': state['answer']}, config)
        return {**state, 'lookup': result}
    return StateGraph(dict).add_node('respond', respond).add_node('lookup', lookup).add_edge(START, 'respond').add_edge('respond', 'lookup').add_edge('lookup', END).compile(checkpointer=checkpointer())
`;

export async function runPyodide(): Promise<PyodideMeasured | PyodideUnmeasured> {
  const probe = await probePyodide();
  if (probe.measurement === 'unmeasured') return probe;
  const files = await inventory();
  const local = JSON.parse(await readFile(join(defaultCache, 'local-wheels.json'), 'utf8')) as {
    packages: PyodideAdapterOptions['localWheels'];
  };
  const assets = new Map<string, Uint8Array>([
    ['/python/agent/coverage.py', new TextEncoder().encode(source)],
  ]);
  for (const wheel of [...files.lockedWheels, ...local.packages])
    assets.set(`/python/wheels/${wheel.file}`, await readFile(join(defaultCache, wheel.file)));
  const server = createServer((request, response) => {
    const body = request.method === 'GET' ? assets.get(request.url ?? '') : undefined;
    response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/octet-stream' });
    response.end(body);
  });
  const workers = new Set<Worker>();
  const terminations: Promise<number>[] = [];
  const workerErrors: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-coverage-python-'));
  const tracing = createProvider({ live: false });
  let runtimeInstance: ReturnType<typeof createRuntime> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = join(directory, 'bootstrap.mjs');
    await writeFile(
      bootstrap,
      `// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
import { parentPort } from 'node:worker_threads';
globalThis.postMessage = (message) => parentPort.postMessage(message);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(value).origin !== ${JSON.stringify(origin)}) {
    parentPort.postMessage({ coverageExternalRequest: true });
    return Promise.reject(new Error('External requests are disabled in this measurement.'));
  }
  return originalFetch(input, init);
};
await import(${JSON.stringify(pathToFileURL(join(built, 'worker.js')).href)});
`,
    );
    const options: PyodideAdapterOptions = {
      framework: 'langgraph',
      runtimeUrl: `${runtime}/`,
      wheelsUrl: `${origin}/python/wheels/`,
      localWheels: local.packages,
      createWorker(): PyodideWorkerPort {
        const worker = new Worker(bootstrap);
        workers.add(worker);
        const messages = new Set<(event: { readonly data: unknown }) => void>();
        const errors = new Set<() => void>();
        worker.on('message', (data: unknown) => {
          if (typeof data === 'object' && data !== null && 'coverageExternalRequest' in data) {
            workerErrors.push('External request attempted');
            return;
          }
          for (const listener of messages) listener({ data });
        });
        worker.on('error', (error) => {
          workerErrors.push(error.message);
          for (const listener of errors) listener();
        });
        return {
          postMessage: (message) => worker.postMessage(message),
          addEventListener(type, listener) {
            if (type === 'message')
              messages.add(listener as (event: { readonly data: unknown }) => void);
            else errors.add(listener as () => void);
          },
          removeEventListener(type, listener) {
            if (type === 'message')
              messages.delete(listener as (event: { readonly data: unknown }) => void);
            else errors.delete(listener as () => void);
          },
          terminate() {
            if (workers.delete(worker)) terminations.push(worker.terminate());
          },
        };
      },
    };
    const model = new MockChatModel({
      'synthetic python prompt': {
        id: 'python-coverage-reply',
        text: 'synthetic python reply',
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    });
    let capabilityCalls = 0;
    runtimeInstance = createRuntime({
      appId: 'span-coverage-python',
      executors: [createPyodideAdapter(options)],
      tracerProvider: tracing.provider,
      outputSafety: () => 'allow',
    });
    const value = z.object({ value: z.string() });
    const instance = await runtimeInstance.create(
      defineAgentDefinition({
        id: 'coverage/python',
        version: '1.0.0',
        executor: 'langgraph-python',
        input: z.object({}),
        models: { answer: { modality: 'text', defaultPolicy: 'local-only' } },
        capabilities: {
          required: { 'lookup@1': { kind: 'read', input: value, output: z.string() } },
        },
      }),
      {
        principalScope: 'coverage',
        agent: {
          baseUrl: `${origin}/python/agent/`,
          files: ['coverage.py'],
          module: 'coverage',
          entry: 'create_agent',
        },
        services: { chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
          consent: () => true,
        },
        bindings: {
          'lookup@1': {
            kind: 'read',
            destination: 'in-browser',
            approval: 'none',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            retry: 'none',
            async invoke(input) {
              assert.deepEqual(input, { value: 'synthetic python reply' });
              capabilityCalls++;
              return 'synthetic capability result';
            },
          },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({});
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) events.push(event);
    assert.equal(instance.getSnapshot().run?.status, 'succeeded', JSON.stringify(events));
    assert.deepEqual(events.find((event) => event.type === 'output')?.output, {
      answer: 'synthetic python reply',
      lookup: 'synthetic capability result',
    });
    assert.equal(model.calls, 1, 'Python model positive control');
    assert.equal(capabilityCalls, 1, 'Python capability positive control');
    assert.deepEqual(workerErrors, []);
    await runtimeInstance.dispose();
    await tracing.flush();
    const spans = [...tracing.oracle.getFinishedSpans()];
    const roots = spans.filter(
      (span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent',
    );
    assert.equal(roots.length, 1, 'Python root span positive control');
    assert.equal(roots[0]?.attributes['galaxie.executor.id'], 'langgraph-python');
    assert.equal(
      spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'execute_tool').length,
      1,
      'Python capability span positive control',
    );
    const manifest = JSON.parse(await readFile(join(built, '../package.json'), 'utf8')) as {
      dependencies: { pyodide: string };
    };
    return {
      measurement: 'measured',
      spans,
      modelCalls: model.calls,
      capabilityCalls,
      outputCorrect: true,
      versions: { pyodide: manifest.dependencies.pyodide },
    };
  } finally {
    await runtimeInstance?.dispose();
    for (const worker of workers) terminations.push(worker.terminate());
    await Promise.all(terminations);
    await tracing.shutdown();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
}
