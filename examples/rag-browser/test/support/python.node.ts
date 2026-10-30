// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import type {
  PyodideAdapterOptions,
  PyodideAgent,
  PyodideBootEvent,
  PyodideWorkerPort,
} from '../../../../packages/adapter-pyodide/src/adapter.js';
import {
  lockedWheels,
  runtimeFiles,
} from '../../../../packages/adapter-pyodide/src/runtime-files.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const cache = join(repository, '.cache/python-wheels');
export const pythonWheelsAvailable: boolean = existsSync(join(cache, 'local-wheels.json'));
export const missingPythonWheels: string =
  'Python wheels are not fetched; run the wheel fetch script';
if (!pythonWheelsAvailable && process.env['CI']) throw new Error(missingPythonWheels);

export interface PythonFixture {
  readonly options: PyodideAdapterOptions;
  readonly agent: PyodideAgent;
  readonly origin: string;
  readonly toWorker: string[];
  readonly fromWorker: string[];
  readonly requests: { readonly url: string; readonly bytes: number }[];
  readonly counts: { created: number; terminated: number };
  readonly bootEvents: PyodideBootEvent[];
  readonly workerErrors: string[];
  readonly enteredBusyLoop: Promise<void>;
  cleanup(): Promise<void>;
}
export interface PythonFixtureInput {
  readonly sources?: Readonly<Record<string, string>>;
  readonly module?: string;
  readonly entry?: string;
}

export async function createPythonFixture(input: PythonFixtureInput = {}): Promise<PythonFixture> {
  if (!pythonWheelsAvailable) throw new Error(missingPythonWheels);
  const packageRoot = join(repository, 'packages/adapter-pyodide');
  const runtime = join(packageRoot, 'node_modules/pyodide/');
  const base = join(packageRoot, 'node_modules/.cache');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'galaxie-python-'));
  const local = JSON.parse(await readFile(join(cache, 'local-wheels.json'), 'utf8')) as {
    packages: PyodideAdapterOptions['localWheels'];
  };
  const sources: Record<string, string> = {};
  if (input.sources) Object.assign(sources, input.sources);
  else {
    for (const file of ['__init__.py', 'graph.py', 'citations.py', 'prompt.py'])
      sources[`rag_agent/${file}`] = await readFile(
        join(repository, 'examples/rag-browser/agent_py/rag_agent', file),
        'utf8',
      );
    sources['rag_agent/prompt.json'] = await readFile(
      join(repository, 'examples/rag-browser/src/agent/prompt.json'),
      'utf8',
    );
  }
  const assets = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(sources))
    assets.set(`/python/agent/${path}`, new TextEncoder().encode(text));
  for (const wheel of [...lockedWheels, ...local.packages])
    assets.set(`/python/wheels/${wheel.file}`, await readFile(join(cache, wheel.file)));
  for (const file of runtimeFiles)
    assets.set(`/python/runtime/${file.file}`, await readFile(join(runtime, file.file)));
  const requests: PythonFixture['requests'] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const body = request.method === 'GET' ? assets.get(path) : undefined;
    requests.push({ url: path, bytes: body?.byteLength ?? 0 });
    response.writeHead(body ? 200 : 404, {
      'Content-Type':
        path.endsWith('.py') || path.endsWith('.json')
          ? 'text/plain; charset=utf-8'
          : 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The Python fixture has no port.');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await build({
      configFile: false,
      root: packageRoot,
      logLevel: 'silent',
      build: {
        ssr: join(packageRoot, 'src/worker.ts'),
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        rolldownOptions: {
          external: ['pyodide', 'node:worker_threads'],
          output: { entryFileNames: 'worker.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    });
    await writeFile(
      join(directory, 'bundle/bootstrap.mjs'),
      `
import { parentPort } from 'node:worker_threads';
globalThis.postMessage = (message) => parentPort.postMessage(message);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(value).origin !== ${JSON.stringify(origin)}) return Promise.reject(new Error('External requests are disabled in this test.'));
  return originalFetch(input, init);
};
await import('./worker.mjs');
`,
    );
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const workers = new Set<Worker>();
  const terminations: Promise<number>[] = [];
  const toWorker: string[] = [];
  const fromWorker: string[] = [];
  const counts = { created: 0, terminated: 0 };
  const bootEvents: PyodideBootEvent[] = [];
  const workerErrors: string[] = [];
  const enteredBusyLoop = Promise.withResolvers<void>();
  return {
    options: {
      runtimeUrl: runtime,
      wheelsUrl: `${origin}/python/wheels/`,
      localWheels: local.packages,
      onBoot: (event) => {
        bootEvents.push(event);
      },
      createWorker(): PyodideWorkerPort {
        const worker = new Worker(join(directory, 'bundle/bootstrap.mjs'));
        workers.add(worker);
        counts.created++;
        const messages = new Set<(event: { readonly data: unknown }) => void>();
        const errors = new Set<() => void>();
        worker.on('message', (data: unknown) => {
          if (data === 'test:entered-busy-loop') {
            enteredBusyLoop.resolve();
            return;
          }
          fromWorker.push(String(data));
          for (const listener of messages) listener({ data });
        });
        worker.on('error', (error) => {
          workerErrors.push(error.message);
          for (const listener of errors) listener();
        });
        return {
          postMessage(message) {
            toWorker.push(message);
            worker.postMessage(message);
          },
          addEventListener(
            type: 'message' | 'error',
            listener: ((event: { readonly data: unknown }) => void) | (() => void),
          ) {
            if (type === 'message')
              messages.add(listener as (event: { readonly data: unknown }) => void);
            else errors.add(listener as () => void);
          },
          removeEventListener(
            type: 'message' | 'error',
            listener: ((event: { readonly data: unknown }) => void) | (() => void),
          ) {
            if (type === 'message')
              messages.delete(listener as (event: { readonly data: unknown }) => void);
            else errors.delete(listener as () => void);
          },
          terminate() {
            if (!workers.delete(worker)) return;
            counts.terminated++;
            terminations.push(worker.terminate());
          },
        };
      },
    },
    agent: {
      baseUrl: `${origin}/python/agent/`,
      files: Object.keys(sources),
      module: input.module ?? 'rag_agent.graph',
      entry: input.entry ?? 'create_agent',
    },
    origin,
    toWorker,
    fromWorker,
    requests,
    counts,
    bootEvents,
    workerErrors,
    enteredBusyLoop: enteredBusyLoop.promise,
    async cleanup() {
      for (const worker of workers) terminations.push(worker.terminate());
      workers.clear();
      await Promise.all(terminations);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
      // Pyodide must not cache packages under the loopback URL taken as a working-directory path.
      if (existsSync(new URL(origin).protocol))
        throw new Error('Pyodide wrote a package cache into the working directory.');
    },
  };
}
