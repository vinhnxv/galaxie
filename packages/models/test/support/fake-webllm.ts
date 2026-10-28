// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  WebLLMClient,
  WebLLMEngineConfig,
  WebLLMGPU,
  WebLLMModule,
  WebLLMWorker,
} from '../../src/webllm/engine.js';

export class FakeWebLLMWorker implements WebLLMWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];
  terminations = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  terminate(): void {
    this.terminations++;
  }
  fail(kind: 'error' | 'messageerror' = 'error'): void {
    if (kind === 'error') this.onerror?.({ preventDefault() {} } as ErrorEvent);
    else this.onmessageerror?.({} as MessageEvent);
  }
}

export interface FakeWebLLMOptions {
  readonly reload?: () => Promise<void>;
  readonly unload?: () => Promise<void>;
}

export class FakeWebLLMClient implements WebLLMClient {
  readonly config: WebLLMEngineConfig;
  reloads: string[] = [];
  unloads = 0;
  readonly #options: FakeWebLLMOptions;

  constructor(config: WebLLMEngineConfig, options: FakeWebLLMOptions) {
    this.config = config;
    this.#options = options;
  }
  async reload(modelId: string): Promise<void> {
    this.reloads.push(modelId);
    await this.#options.reload?.();
  }
  async unload(): Promise<void> {
    this.unloads++;
    await this.#options.unload?.();
  }
}

export function createFakeWebLLM(options: FakeWebLLMOptions = {}): {
  worker: FakeWebLLMWorker;
  gpu: WebLLMGPU;
  module: WebLLMModule;
  readonly engine: FakeWebLLMClient;
  readonly constructions: number;
} {
  const engines: FakeWebLLMClient[] = [];
  return {
    worker: new FakeWebLLMWorker(),
    gpu: {
      async requestAdapter() {
        return {
          features: new Set(['shader-f16']),
          info: { vendor: 'fake-vendor', architecture: 'fake-architecture' },
        };
      },
    },
    module: {
      WebWorkerMLCEngine: class extends FakeWebLLMClient {
        constructor(worker: WebLLMWorker, config: WebLLMEngineConfig) {
          if (worker.onerror === null || worker.onmessageerror === null)
            throw new Error('Failure listeners must precede engine construction.');
          super(config, options);
          engines.push(this);
        }
      },
    },
    get engine() {
      const engine = engines[0];
      if (engine === undefined) throw new Error('The fake engine was not constructed.');
      return engine;
    },
    get constructions() {
      return engines.length;
    },
  };
}
