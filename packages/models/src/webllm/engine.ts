// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { WebLLMError, WebLLMProviderError, type WebLLMUnavailableReason } from '../errors.js';
import { classifyWebLLMError } from './classify.js';
import {
  buildAppConfig,
  defaultWebLLMModel,
  type WebLLMAppConfig,
  type WebLLMModelRecord,
} from './model-record.js';

/** The local structural seam avoids WebLLM's extensionless declaration re-exports. */
export interface WebLLMWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface WebLLMGPU {
  requestAdapter(options: { powerPreference: 'high-performance' }): Promise<{
    readonly features: { has(feature: string): boolean };
    readonly info: { readonly vendor?: string; readonly architecture?: string };
  } | null>;
}

export interface WebLLMProgress {
  readonly phase: 'download' | 'load' | 'unknown';
  readonly fraction: number;
  readonly elapsedSeconds: number;
}

export interface WebLLMDevice {
  readonly backend: 'webgpu';
  readonly thread: 'worker';
  readonly vendor: string;
  readonly architecture: string;
}

export interface WebLLMEngineConfig {
  readonly appConfig: WebLLMAppConfig;
  readonly initProgressCallback: (report: {
    progress: number;
    timeElapsed: number;
    text: string;
  }) => void;
}

export interface WebLLMClient {
  reload(modelId: string): Promise<void>;
  unload(): Promise<void>;
  resetChat(): Promise<void>;
  interruptGenerate(): void;
  readonly chat: {
    readonly completions: { create(request: WebLLMRequest): Promise<AsyncIterable<WebLLMChunk>> };
  };
}

export interface WebLLMRequest {
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly max_tokens: number;
  readonly temperature: number;
  readonly response_format?: { readonly type: 'json_object'; readonly schema: string };
}

export interface WebLLMChunk {
  readonly id?: string;
  readonly choices: readonly {
    readonly delta: { readonly content?: string | null };
    readonly finish_reason: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens?: number;
  } | null;
}

export interface WebLLMModule {
  readonly WebWorkerMLCEngine: new (
    worker: WebLLMWorker,
    config: WebLLMEngineConfig,
  ) => WebLLMClient;
}

export interface LoadWebLLMEngineOptions {
  readonly worker: WebLLMWorker;
  readonly model?: WebLLMModelRecord;
  readonly onProgress?: (progress: WebLLMProgress) => void;
  readonly signal?: AbortSignal;
}

class EngineLifetime {
  readonly #worker: WebLLMWorker;
  #failed = false;
  #error: unknown;
  #terminated = false;
  readonly #listeners = new Set<() => void>();

  constructor(worker: WebLLMWorker) {
    this.#worker = worker;
    worker.onerror = (event): void => {
      event.preventDefault();
      this.fail(new WebLLMError('unavailable', 'worker_failed'));
      this.terminate();
    };
    worker.onmessageerror = (): void => {
      this.fail(new WebLLMError('unavailable', 'worker_failed'));
      this.terminate();
    };
  }

  get failed(): boolean {
    return this.#failed;
  }
  get error(): unknown {
    return this.#error;
  }

  fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#error = error;
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    if (this.#failed) {
      listener();
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // A shared pending failure promise would retain every completed chunk until disposal.
  race<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onFailure = (): void => {
        this.#listeners.delete(onFailure);
        reject(this.#error);
      };
      if (this.#failed) onFailure();
      else this.#listeners.add(onFailure);
      // Consume late engine rejections even after failure has already won.
      operation.then(
        (value) => {
          this.#listeners.delete(onFailure);
          resolve(value);
        },
        (error: unknown) => {
          this.#listeners.delete(onFailure);
          reject(error);
        },
      );
    });
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#worker.terminate();
  }
}

export class WebLLMEngineHandle {
  readonly modelId: string;
  readonly device: WebLLMDevice;
  readonly #engine: WebLLMClient;
  readonly #lifetime: EngineLifetime;
  #disposal: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    engine: WebLLMClient,
    lifetime: EngineLifetime,
    modelId: string,
    device: WebLLMDevice,
  ) {
    this.#engine = engine;
    this.#lifetime = lifetime;
    this.modelId = modelId;
    this.device = Object.freeze(device);
  }

  /** One shared turn covers reset, creation, every pull and the stream's final return. */
  async *stream(request: WebLLMRequest, signal?: AbortSignal): AsyncGenerator<WebLLMChunk> {
    if (this.#lifetime.failed) throw this.#lifetime.error;
    signal?.throwIfAborted();
    const previous = this.#tail;
    const released = Promise.withResolvers<void>();
    this.#tail = previous.then(() => released.promise);
    const aborted = Promise.withResolvers<never>();
    void aborted.promise.catch(() => {});
    let running = false;
    let iterator: AsyncIterator<WebLLMChunk> | undefined;
    let closing: Promise<void> | undefined;
    let failed = false;
    const close = (): Promise<void> => {
      if (iterator === undefined) return Promise.resolve();
      closing ??= this.#lifetime.race(
        Promise.resolve().then(async () => {
          await iterator?.return?.();
        }),
      );
      return closing;
    };
    const onAbort = (): void => {
      aborted.reject(signal?.reason);
      if (!running) return;
      try {
        this.#engine.interruptGenerate();
      } catch {}
      if (iterator !== undefined) void close().then(released.resolve, released.resolve);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = this.#lifetime.subscribe(() => {
      if (iterator !== undefined) void close().then(released.resolve, released.resolve);
    });
    const check = (): void => {
      if (this.#lifetime.failed) throw this.#lifetime.error;
      signal?.throwIfAborted();
    };
    const failure = (error: unknown): unknown => {
      if (this.#lifetime.failed) return this.#lifetime.error;
      if (signal?.aborted) return signal.reason;
      const classified = classifyWebLLMError(error);
      if (classified === undefined) return new WebLLMProviderError();
      const mapped = new WebLLMError(
        classified.code,
        classified.code === 'unavailable' ? classified.reason : undefined,
      );
      if (classified.code === 'unavailable') this.#lifetime.fail(mapped);
      return mapped;
    };
    const cleanup = async (): Promise<void> => {
      try {
        await close();
      } catch (error) {
        if (!failed) throw failure(error);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
        released.resolve();
      }
    };
    try {
      if (signal?.aborted) onAbort();
      await this.#lifetime.race(Promise.race([previous, aborted.promise]));
      check();
      running = true;
      await this.#lifetime.race(this.#engine.resetChat());
      check();
      // Creation must settle before releasing the turn, so an abort cannot orphan a late stream.
      const stream = await this.#lifetime.race(this.#engine.chat.completions.create(request));
      iterator = stream[Symbol.asyncIterator]();
      check();
      while (true) {
        check();
        const next = await this.#lifetime.race(Promise.race([iterator.next(), aborted.promise]));
        check();
        if (next.done) break;
        yield next.value;
      }
    } catch (error) {
      failed = true;
      throw failure(error);
    } finally {
      await cleanup();
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    // Settle pending engine operations before unload; the worker may never answer them.
    this.#lifetime.fail(new WebLLMError('unavailable', 'disposed'));
    this.#disposal = (async (): Promise<void> => {
      try {
        await this.#lifetime.race(this.#engine.unload());
      } catch {
      } finally {
        this.#lifetime.terminate();
      }
    })();
    return this.#disposal;
  }
}

function progressPhase(text: string): WebLLMProgress['phase'] {
  if (text.startsWith('Fetching param cache[') || text === 'Start to fetch params')
    return 'download';
  if (
    text.startsWith('Loading model from cache[') ||
    text.startsWith('Loading GPU shader modules[') ||
    text.startsWith('Finish loading on ')
  )
    return 'load';
  return 'unknown';
}

function loadFailure(error: unknown): WebLLMError {
  const classification = classifyWebLLMError(error);
  const reason: WebLLMUnavailableReason =
    classification?.code === 'unavailable' ? classification.reason : 'load_failed';
  return new WebLLMError('unavailable', reason);
}

/** Internal injection factory: tests supply a fake module, never the real engine bundle. */
export async function createWebLLMEngine(
  options: LoadWebLLMEngineOptions,
  dependencies: {
    readonly gpu: WebLLMGPU | undefined;
    readonly loadModule: () => Promise<WebLLMModule>;
  },
): Promise<WebLLMEngineHandle> {
  const model = options.model ?? defaultWebLLMModel;
  const appConfig = buildAppConfig(model);
  const lifetime = new EngineLifetime(options.worker);
  let engine: WebLLMClient | undefined;
  const onAbort = (): void => lifetime.fail(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (options.signal?.aborted) onAbort();
    if (lifetime.failed) throw lifetime.error;
    if (dependencies.gpu === undefined) throw new WebLLMError('unavailable', 'no_webgpu');
    const adapter = await lifetime.race(
      dependencies.gpu.requestAdapter({ powerPreference: 'high-performance' }),
    );
    if (adapter === null) throw new WebLLMError('unavailable', 'no_adapter');
    if (model.requiredFeatures?.includes('shader-f16') && !adapter.features.has('shader-f16'))
      throw new WebLLMError('unavailable', 'no_shader_f16');
    const module = await lifetime.race(dependencies.loadModule());
    if (lifetime.failed) throw lifetime.error;
    engine = new module.WebWorkerMLCEngine(options.worker, {
      appConfig,
      initProgressCallback(report) {
        if (lifetime.failed) return;
        options.onProgress?.({
          phase: progressPhase(report.text),
          fraction: report.progress,
          elapsedSeconds: report.timeElapsed,
        });
      },
    });
    await lifetime.race(engine.reload(model.modelId));
    if (options.signal?.aborted) throw options.signal.reason;
    if (lifetime.failed) throw lifetime.error;
    return new WebLLMEngineHandle(engine, lifetime, model.modelId, {
      backend: 'webgpu',
      thread: 'worker',
      vendor: adapter.info.vendor ?? '',
      architecture: adapter.info.architecture ?? '',
    });
  } catch (error) {
    const failure = options.signal?.aborted
      ? options.signal.reason
      : lifetime.failed
        ? lifetime.error
        : error instanceof WebLLMError
          ? error
          : loadFailure(error);
    lifetime.fail(failure);
    if (engine !== undefined) {
      try {
        await lifetime.race(engine.unload());
      } catch {}
    }
    lifetime.terminate();
    throw failure;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function loadWebLLMEngine(
  options: LoadWebLLMEngineOptions,
): Promise<WebLLMEngineHandle> {
  const gpu = (globalThis.navigator as (Navigator & { readonly gpu?: WebLLMGPU }) | undefined)?.gpu;
  return createWebLLMEngine(options, {
    gpu,
    loadModule: async () => (await import('@mlc-ai/web-llm')) as unknown as WebLLMModule,
  });
}
