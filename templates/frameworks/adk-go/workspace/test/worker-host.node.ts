// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  type NodeHost,
  startNodeHost,
} from '../../../../../../examples/rag-browser/test/support/adk-go-reference.node.js';

/** Exercise the shipped Go Worker in Node, adapting only browser messaging and location. */
export async function createWorkerHost(): Promise<NodeHost> {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const dist = join(project, 'node_modules/@galaxie-ai/starter-go/dist');
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8')) as {
    wasm: { bytes: number; sha256: string };
  };
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-starter-worker-'));
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: {
          '@galaxie-ai/adapter-go/worker': fileURLToPath(
            new URL('../../../../../../packages/adapter-go/src/worker.ts', import.meta.url),
          ),
        },
      },
      plugins: [
        {
          name: 'starter-go-node-glue',
          resolveId(id) {
            return id === 'virtual:galaxie-go-glue' ? '\0starter-go-node-glue' : undefined;
          },
          load(id) {
            return id === '\0starter-go-node-glue'
              ? readFile(join(dist, 'wasm_exec.js'), 'utf8')
              : undefined;
          },
        },
      ],
      build: {
        ssr: join(project, 'src/go-worker.ts'),
        outDir: directory,
        emptyOutDir: true,
        rolldownOptions: { output: { entryFileNames: 'worker.mjs' } },
      },
    });
    await writeFile(
      join(directory, 'bootstrap.mjs'),
      `import { parentPort, workerData } from 'node:worker_threads';
globalThis.location = new URL(workerData.origin);
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
await import('./worker.mjs');
`,
    );
    const host = await startNodeHost({
      directory,
      bundle: directory,
      file: join(dist, 'agent.wasm'),
      wasm: { ...manifest.wasm, url: '/go/agent.wasm' },
    });
    return {
      ...host,
      async close() {
        await host.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
