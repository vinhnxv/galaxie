// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { TransformersWorker } from '../../src/transformers/engine.js';
import { storedBytesHeader, storedSha256Header } from '../../src/transformers/model-files.js';
import { modelFileUrl } from '../../src/transformers/model-record.js';
import type { FromWorker } from '../../src/transformers/protocol.js';
import { createWorkerHost, type WorkerHost } from '../../src/transformers/worker-host.js';
import {
  createFakeRuntime,
  type FakeRuntime,
  type FakeRuntimeOptions,
} from './fake-transformers-runtime.js';
import {
  createFakeFetch,
  createSyntheticModel,
  type FakeFetch,
  MemoryStore,
  type SyntheticModel,
} from './transformers-model.js';

export const assets = { mjs: 'https://app.test/ort.mjs', wasm: 'https://app.test/ort.wasm' };

/** Runs the page engine against the Worker host in one process, through structured clones. */
export class LoopbackWorker implements TransformersWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly toWorker: unknown[] = [];
  terminated = 0;
  host: WorkerHost | undefined;

  postMessage(message: unknown): void {
    const copy = structuredClone(message);
    this.toWorker.push(copy);
    queueMicrotask(() => this.host?.receive(copy));
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** A Worker script error, as the browser reports it. */
  fail(): void {
    this.onerror?.({ preventDefault() {} } as unknown as ErrorEvent);
  }

  deliver(message: FromWorker): void {
    const copy = structuredClone(message);
    queueMicrotask(() => this.onmessage?.({ data: copy } as MessageEvent));
  }
}

export interface LoopbackParts {
  readonly model: SyntheticModel;
  readonly store: MemoryStore;
  readonly runtime: FakeRuntime;
  readonly fetcher: FakeFetch;
  readonly worker: LoopbackWorker;
}

export async function setup(
  options: {
    model?: SyntheticModel;
    runtime?: FakeRuntimeOptions;
    store?: MemoryStore;
    served?: boolean;
  } = {},
): Promise<LoopbackParts> {
  const model = options.model ?? (await createSyntheticModel());
  const store = options.store ?? new MemoryStore();
  const runtime = createFakeRuntime(options.runtime);
  const fetcher = createFakeFetch(model.served);
  const worker = new LoopbackWorker();
  worker.host = createWorkerHost({
    post: (message) => worker.deliver(message),
    runtime,
    assets,
    openStore: async () => store,
    fetch: fetcher.fetch,
    now: () => 0,
  });
  return { model, store, runtime, fetcher, worker };
}

export async function seed(store: MemoryStore, model: SyntheticModel): Promise<void> {
  for (const file of model.record.files) {
    const url = modelFileUrl(model.record, file);
    store.entries.set(url, {
      bytes: model.served.get(url) as Uint8Array<ArrayBuffer>,
      headers: [
        [storedBytesHeader, String(file.bytes)],
        [storedSha256Header, file.sha256],
      ],
    });
  }
}
