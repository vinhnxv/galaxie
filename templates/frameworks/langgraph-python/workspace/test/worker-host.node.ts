// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createPythonFixture } from '../../../../../../examples/rag-browser/test/support/python.node.js';

interface WorkerHost {
  readonly location: string;
  readonly workerScript: RegExp;
  readonly sources: {
    readonly paths: readonly string[];
    readonly requests: readonly string[];
    fetch: typeof fetch;
  };
  createWorker(): object;
  close(): Promise<void>;
}

/** Keep the real adapter/Worker; adapt only Node runtime loading and browser messaging. */
export async function createWorkerHost(): Promise<WorkerHost> {
  const files = ['starter_agent/__init__.py', 'starter_agent/graph.py'];
  const sources = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(new URL(`../python/agent/${file}`, import.meta.url), 'utf8'),
      ]),
    ),
  );
  const fixture = await createPythonFixture({ sources, module: 'starter_agent.graph' });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const paths = files.map((file) => `/python/agent/${file}`);
  return {
    location: fixture.origin,
    workerScript: /pyodide-worker\.ts$/,
    sources: {
      paths,
      requests,
      async fetch(input, init) {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.origin !== fixture.origin || !paths.includes(url.pathname))
          throw new Error('Only the declared Python source requests are allowed.');
        requests.push(url.pathname);
        return originalFetch(input, init);
      },
    },
    createWorker() {
      const worker = fixture.options.createWorker();
      return {
        ...worker,
        postMessage(message: string) {
          const value = JSON.parse(message) as { op: string; payload: { runtimeUrl?: string } };
          if (value.op === 'boot') value.payload.runtimeUrl = fixture.options.runtimeUrl;
          worker.postMessage(JSON.stringify(value));
        },
      };
    },
    close: () => fixture.cleanup(),
  };
}
