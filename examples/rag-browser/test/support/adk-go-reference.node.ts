// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'vite';
import type { GoWorkerPort } from '../../../../packages/adapter-go/src/adapter.js';
import { buildGoWasm } from '../../../../scripts/build-go-wasm.ts';
import { fetchGoGlue } from '../../../../scripts/fetch-go-glue.ts';
import { goAvailable, missingGo } from './go-gate.node.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const workerEntry = join(root, 'examples/rag-browser/test/support/go-gate/adapter-worker.ts');

export interface Reference {
  readonly directory: string;
  readonly file: string;
  readonly wasm: { readonly url: string; readonly sha256: string; readonly bytes: number };
  readonly bundle: string;
}

let built: Promise<Reference> | undefined;

export function buildReference(): Promise<Reference> {
  built ??= (async () => {
    if (!goAvailable) throw new Error(missingGo);
    await fetchGoGlue();
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-adk-go-'));
    const file = join(directory, 'reference.wasm');
    const module = await buildGoWasm('./conformance/reference', file);
    const bundle = join(directory, 'node-bundle');
    await build({
      configFile: false,
      root: join(root, 'examples/rag-browser/test/support/go-gate'),
      logLevel: 'silent',
      build: {
        ssr: workerEntry,
        outDir: bundle,
        emptyOutDir: true,
        rolldownOptions: {
          output: { entryFileNames: 'worker.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    });
    await writeFile(
      join(bundle, 'bootstrap.mjs'),
      `import { parentPort, workerData } from 'node:worker_threads';
globalThis.location = new URL(workerData.origin);
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
await import('./worker.mjs');
`,
    );
    return {
      directory,
      file,
      bundle,
      wasm: { url: '/reference.wasm', sha256: module.sha256, bytes: module.bytes },
    };
  })();
  return built;
}

export async function disposeReference(): Promise<void> {
  if (!built) return;
  const reference = await built.catch(() => undefined);
  if (reference) await rm(reference.directory, { recursive: true, force: true });
}

export interface NodeHost {
  readonly wasm: { readonly url: string; readonly sha256: string; readonly bytes: number };
  /** Builds a Worker port; every message the Worker sends the page is also appended to `traffic`. */
  createWorker(): GoWorkerPort;
  readonly traffic: string[];
  readonly workers: Worker[];
  close(): Promise<void>;
}

export async function startNodeHost(reference: Reference): Promise<NodeHost> {
  const wasm = await readFile(reference.file);
  const server: Server = createServer((request, response) => {
    if (request.url !== reference.wasm.url) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/wasm' }).end(wasm);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The server has no port.');
  const origin = `http://127.0.0.1:${address.port}/`;
  const traffic: string[] = [];
  const workers: Worker[] = [];
  return {
    wasm: { ...reference.wasm, url: `${origin}${reference.wasm.url.slice(1)}` },
    traffic,
    workers,
    createWorker(): GoWorkerPort {
      const worker = new Worker(join(reference.bundle, 'bootstrap.mjs'), {
        workerData: { origin },
      });
      workers.push(worker);
      const messages = new Map<
        (event: { readonly data: unknown }) => void,
        (data: unknown) => void
      >();
      return {
        postMessage: (message) => {
          traffic.push(`page>${message}`);
          worker.postMessage(message);
        },
        addEventListener: ((type: 'message' | 'error', listener: never): void => {
          if (type === 'message') {
            const wrapped = (data: unknown): void => {
              if (typeof data === 'string') traffic.push(`worker>${data}`);
              (listener as (event: { readonly data: unknown }) => void)({ data });
            };
            messages.set(listener, wrapped);
            worker.on('message', wrapped);
          } else {
            worker.on('error', listener);
          }
        }) as GoWorkerPort['addEventListener'],
        removeEventListener: ((type: 'message' | 'error', listener: never): void => {
          if (type === 'message') {
            const wrapped = messages.get(listener);
            if (wrapped) worker.off('message', wrapped);
            messages.delete(listener);
          } else {
            worker.off('error', listener);
          }
        }) as GoWorkerPort['removeEventListener'],
        terminate: () => void worker.terminate(),
      };
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.terminate()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
