// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { WebLLMCacheModule } from '../../src/webllm/cache.js';
import type {
  WebLLMChunk,
  WebLLMClient,
  WebLLMEngineConfig,
  WebLLMGPU,
  WebLLMModule,
  WebLLMRequest,
  WebLLMWorker,
} from '../../src/webllm/engine.js';
import type { WebLLMAppConfig } from '../../src/webllm/model-record.js';

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
  readonly reset?: () => Promise<void>;
  readonly create?: (request: WebLLMRequest) => Promise<FakeWebLLMStream>;
}

export const fakeWebLLMChunks: readonly WebLLMChunk[] = [
  { choices: [{ delta: { content: 'hello ' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'world' }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
];

/** A stream can emit a late result even after return, like an outstanding worker request. */
export class FakeWebLLMStream implements AsyncIterableIterator<WebLLMChunk> {
  readonly chunks: readonly WebLLMChunk[];
  readonly #options: {
    readonly beforeNext?: (index: number) => Promise<void>;
    readonly beforeReturn?: () => Promise<void>;
  };
  nexts = 0;
  returns = 0;
  closed = false;
  onClose: (() => void) | undefined;

  constructor(
    chunks: readonly WebLLMChunk[] = fakeWebLLMChunks,
    options: {
      readonly beforeNext?: (index: number) => Promise<void>;
      readonly beforeReturn?: () => Promise<void>;
    } = {},
  ) {
    this.chunks = chunks;
    this.#options = options;
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<WebLLMChunk> {
    return this;
  }
  async next(): Promise<IteratorResult<WebLLMChunk>> {
    const index = this.nexts++;
    await this.#options.beforeNext?.(index);
    const chunk = this.chunks[index];
    return chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk };
  }
  async return(): Promise<IteratorResult<WebLLMChunk>> {
    this.returns++;
    await this.#options.beforeReturn?.();
    this.closed = true;
    this.onClose?.();
    return { done: true, value: undefined };
  }
}

export class FakeWebLLMClient implements WebLLMClient {
  readonly config: WebLLMEngineConfig;
  reloads: string[] = [];
  unloads = 0;
  resets = 0;
  interrupts = 0;
  readonly requests: WebLLMRequest[] = [];
  readonly streams: FakeWebLLMStream[] = [];
  readonly events: string[] = [];
  readonly chat: {
    completions: { create: (request: WebLLMRequest) => Promise<AsyncIterable<WebLLMChunk>> };
  };
  readonly #options: FakeWebLLMOptions;

  constructor(config: WebLLMEngineConfig, options: FakeWebLLMOptions) {
    this.config = config;
    this.#options = options;
    this.chat = {
      completions: {
        create: async (request) => {
          this.events.push('create');
          this.requests.push(request);
          const stream = (await this.#options.create?.(request)) ?? new FakeWebLLMStream();
          this.streams.push(stream);
          stream.onClose = () => {
            this.events.push('closed');
          };
          return stream;
        },
      },
    };
  }
  async reload(modelId: string): Promise<void> {
    this.reloads.push(modelId);
    await this.#options.reload?.();
  }
  async unload(): Promise<void> {
    this.unloads++;
    await this.#options.unload?.();
  }
  async resetChat(): Promise<void> {
    this.events.push('reset');
    this.resets++;
    await this.#options.reset?.();
  }
  interruptGenerate(): void {
    this.interrupts++;
  }
  assertClosed(): void {
    if (this.streams.some((stream) => !stream.closed))
      throw new Error('A fake WebLLM stream is still open.');
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

export function createFakeWebLLMCache(cached: () => Promise<boolean> = async () => true): {
  module: WebLLMCacheModule;
  checks: Array<{ modelId: string; appConfig: WebLLMAppConfig }>;
} {
  const checks: Array<{ modelId: string; appConfig: WebLLMAppConfig }> = [];
  return {
    checks,
    module: {
      async hasModelInCache(modelId, appConfig) {
        checks.push({ modelId, appConfig });
        return cached();
      },
    },
  };
}
