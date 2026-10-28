// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { WebLLMError, type WebLLMUnavailableReason } from '../errors.js';
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
  readonly #failure = Promise.withResolvers<never>();
  #failed = false;
  #error: unknown;
  #terminated = false;

  constructor(worker: WebLLMWorker) {
    this.#worker = worker;
    // A worker can fail between calls, when no race is currently consuming the rejection.
    void this.#failure.promise.catch(() => {});
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
    this.#failure.reject(error);
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([this.#failure.promise, operation]);
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

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    // Settle pending engine operations before unload; the worker may never answer them.
    this.#lifetime.fail(new WebLLMError('unavailable', 'disposed'));
    this.#disposal = (async (): Promise<void> => {
      try {
        await this.#lifetime.race(this.#engine.unload());
      } catch {
        /* The failed lifetime bounds unload without retaining engine errors. */
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
      } catch {
        /* Cleanup is bounded by the already-settled failure promise. */
      }
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
