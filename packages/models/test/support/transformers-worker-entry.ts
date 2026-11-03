// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// A real module Worker for the loader test: the production Worker host with a fake runtime, an
// in-memory store and a fake fetch. It never touches the network or the real library.
import { createWorkerHost, type WorkerHost } from '../../src/transformers/worker-host.js';
import { createFakeRuntime } from './fake-transformers-runtime.js';
import { createFakeFetch, createSyntheticModel, MemoryStore } from './transformers-model.js';

export const fixedModelId = 'example-org/tiny-fixture';

async function build(): Promise<WorkerHost> {
  const model = await createSyntheticModel({ modelId: fixedModelId });
  const store = new MemoryStore();
  return createWorkerHost({
    post: (message) => self.postMessage(message),
    runtime: createFakeRuntime({ pieces: ['Hello', ' from', ' a worker'] }),
    assets: { mjs: 'https://app.test/ort.mjs', wasm: 'https://app.test/ort.wasm' },
    openStore: async () => store,
    fetch: createFakeFetch(model.served).fetch,
  });
}

// Messages can arrive before the host exists, so they wait for it in arrival order.
const host = build();
self.addEventListener('message', (event) => {
  void host.then((ready) => ready.receive((event as MessageEvent).data));
});
