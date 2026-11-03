// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { EngineLifetime } from '../engine-lifetime.js';
import { ModelError, ModelProviderError } from '../errors.js';
import { parseModelRecord, type TransformersModelRecord } from './model-record.js';
import {
  type DeviceReport,
  type FinishReason,
  type FromWorker,
  type GenerateRequest,
  type LoadPhase,
  parseFromWorker,
  parseToWorker,
} from './protocol.js';

/** The structural Worker seam: the page and tests both satisfy it without DOM types. */
export interface TransformersWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface TransformersGPU {
  requestAdapter(options: { powerPreference: 'high-performance' }): Promise<{
    readonly features: { has(feature: string): boolean };
    readonly info: { readonly vendor?: string; readonly architecture?: string };
  } | null>;
}

export interface TransformersProgress {
  readonly phase: LoadPhase;
  readonly fraction: number;
  readonly elapsedSeconds: number;
}

export type TransformersStreamEvent =
  | { readonly type: 'chunk'; readonly text: string }
  | {
      readonly type: 'done';
      readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
      readonly finishReason: FinishReason;
    };

export interface LoadTransformersEngineOptions {
  readonly worker: TransformersWorker;
  readonly model: TransformersModelRecord;
  /** Only a consent path sets this; with `false` a missing or altered file fails and nothing is fetched. */
  readonly allowDownload?: boolean;
  readonly onProgress?: (progress: TransformersProgress) => void;
  readonly signal?: AbortSignal;
}

/** Dtypes that need the WebGPU `shader-f16` feature. */
const f16Dtypes: readonly string[] = ['fp16', 'q4f16', 'q2f16', 'q1f16'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Turns a validated `failed` message into the page's fixed error. */
function failureError(
  message: Extract<FromWorker, { type: 'failed' }>,
): ModelError | ModelProviderError {
  if (message.code === 'provider') return new ModelProviderError();
  return new ModelError(message.code, message.reason);
}

/**
 * Holds the Worker's messages for the one turn that is waiting for them. Messages that do not
 * parse are dropped, except a malformed `failed`, which still ends the turn as a provider failure.
 */
class Channel {
  readonly #queue: FromWorker[] = [];
  #waiter: ((message: FromWorker) => void) | undefined;
  #target: 'load' | number = 'load';
  #terminated = false;

  constructor(worker: TransformersWorker) {
    worker.onmessage = (event): void => this.#receive(event.data);
  }

  /** Starts a new exchange: stale messages are dropped and only this target's are kept. */
  expect(target: 'load' | number): void {
    this.#target = target;
    this.#queue.length = 0;
    this.#waiter = undefined;
    this.#terminated = false;
  }

  /** True once the current turn's `done` or `failed` message has arrived. */
  get terminated(): boolean {
    return this.#terminated;
  }

  next(): Promise<FromWorker> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      // A newer waiter replaces an abandoned one, so a late message is never swallowed.
      this.#waiter = resolve;
    });
  }

  #receive(data: unknown): void {
    let message = parseFromWorker(data);
    if (message === undefined) {
      if (!isRecord(data) || data['type'] !== 'failed') return;
      const id = data['id'];
      message = {
        type: 'failed',
        ...(typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? { id } : {}),
        code: 'provider',
      };
    }
    const wanted =
      message.type === 'failed'
        ? message.id === undefined || message.id === this.#target
        : message.type === 'ready' || message.type === 'progress'
          ? this.#target === 'load'
          : message.id === this.#target;
    if (!wanted) return;
    if (message.type === 'done' || message.type === 'failed') this.#terminated = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter === undefined) this.#queue.push(message);
    else waiter(message);
  }
}

export class TransformersEngineHandle {
  readonly modelId: string;
  readonly device: DeviceReport;
  readonly #worker: TransformersWorker;
  readonly #channel: Channel;
  readonly #lifetime: EngineLifetime;
  #disposal: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #nextId = 1;

  /** @internal Created by `createTransformersEngine`. */
  constructor(
    worker: TransformersWorker,
    channel: Channel,
    lifetime: EngineLifetime,
    modelId: string,
    device: DeviceReport,
  ) {
    this.#worker = worker;
    this.#channel = channel;
    this.#lifetime = lifetime;
    this.modelId = modelId;
    this.device = Object.freeze({ ...device });
  }

  /**
   * One request at a time, in arrival order. The turn is released only after the Worker reports
   * `done` or `failed`, so an aborted request never overlaps the next one.
   */
  async *stream(
    request: GenerateRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<TransformersStreamEvent> {
    const lifetime = this.#lifetime;
    const channel = this.#channel;
    if (lifetime.failed) throw lifetime.error;
    signal?.throwIfAborted();
    const previous = this.#tail;
    const released = Promise.withResolvers<void>();
    this.#tail = previous.then(() => released.promise);
    const aborted = Promise.withResolvers<never>();
    void aborted.promise.catch(() => {});
    const id = this.#nextId;
    this.#nextId += 1;
    let started = false;
    let abortPosted = false;
    const postAbort = (): void => {
      if (!started || channel.terminated || abortPosted) return;
      abortPosted = true;
      try {
        this.#worker.postMessage({ type: 'abort', id });
      } catch {}
    };
    const onAbort = (): void => {
      aborted.reject(signal?.reason);
      postAbort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // A failed lifetime never answers again, so it releases the turn too.
    const unsubscribe = lifetime.subscribe(() => released.resolve());
    void released.promise.then(unsubscribe);
    const check = (): void => {
      if (lifetime.failed) throw lifetime.error;
      signal?.throwIfAborted();
    };
    const failure = (error: unknown): unknown => {
      if (lifetime.failed) return lifetime.error;
      if (signal?.aborted) return signal.reason;
      return error instanceof ModelError || error instanceof ModelProviderError
        ? error
        : new ModelProviderError();
    };
    const drain = async (): Promise<void> => {
      try {
        while (!channel.terminated) await lifetime.race(channel.next());
      } catch {
      } finally {
        released.resolve();
      }
    };
    try {
      if (signal?.aborted) onAbort();
      await lifetime.race(Promise.race([previous, aborted.promise]));
      check();
      // A request the Worker would drop must fail here, or no answer would ever arrive.
      const message = { type: 'generate', id, request } as const;
      if (parseToWorker(message) === undefined) throw new ModelError('invalid');
      channel.expect(id);
      try {
        this.#worker.postMessage(message);
      } catch {
        throw new ModelError('invalid');
      }
      started = true;
      for (;;) {
        const message = await lifetime.race(Promise.race([channel.next(), aborted.promise]));
        check();
        if (message.type === 'chunk') {
          yield { type: 'chunk', text: message.text };
        } else if (message.type === 'done') {
          yield { type: 'done', usage: message.usage, finishReason: message.finishReason };
          return;
        } else if (message.type === 'failed') {
          const error = failureError(message);
          // An unavailable runtime does not recover, so the handle stops accepting requests.
          if (message.code === 'unavailable') lifetime.fail(error);
          throw error;
        }
      }
    } catch (error) {
      throw failure(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!started || channel.terminated) released.resolve();
      else {
        postAbort();
        void drain();
      }
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#lifetime.fail(new ModelError('unavailable', 'disposed'));
    this.#disposal = (async (): Promise<void> => {
      try {
        this.#worker.postMessage({ type: 'dispose' });
      } catch {
      } finally {
        this.#lifetime.terminate();
      }
    })();
    return this.#disposal;
  }
}

/** Internal injection factory: tests supply the GPU and a fake Worker. */
export async function createTransformersEngine(
  options: LoadTransformersEngineOptions,
  dependencies: { readonly gpu: TransformersGPU | undefined },
): Promise<TransformersEngineHandle> {
  const { worker, signal } = options;
  const lifetime = new EngineLifetime(worker);
  const channel = new Channel(worker);
  const onAbort = (): void => lifetime.fail(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    if (lifetime.failed) throw lifetime.error;
    const record = parseModelRecord(options.model);
    if (record.device === 'webgpu') {
      if (dependencies.gpu === undefined) throw new ModelError('unavailable', 'no_webgpu');
      const adapter = await lifetime.race(
        dependencies.gpu.requestAdapter({ powerPreference: 'high-performance' }),
      );
      if (adapter === null) throw new ModelError('unavailable', 'no_adapter');
      if (f16Dtypes.includes(record.dtype) && !adapter.features.has('shader-f16'))
        throw new ModelError('unavailable', 'no_shader_f16');
    }
    channel.expect('load');
    worker.postMessage({ type: 'load', record, allowDownload: options.allowDownload === true });
    for (;;) {
      const message = await lifetime.race(channel.next());
      if (signal?.aborted) throw signal.reason;
      if (lifetime.failed) throw lifetime.error;
      if (message.type === 'progress') {
        options.onProgress?.({
          phase: message.phase,
          fraction: message.fraction,
          elapsedSeconds: message.elapsedSeconds,
        });
      } else if (message.type === 'failed') {
        throw failureError(message);
      } else if (message.type === 'ready') {
        // The Worker must have started the backend the record asked for.
        if (message.device.backend !== record.device)
          throw new ModelError('unavailable', 'load_failed');
        return new TransformersEngineHandle(
          worker,
          channel,
          lifetime,
          record.modelId,
          message.device,
        );
      }
    }
  } catch (error) {
    const failure = signal?.aborted
      ? signal.reason
      : lifetime.failed
        ? lifetime.error
        : error instanceof ModelError || error instanceof ModelProviderError
          ? error
          : new ModelError('unavailable', 'load_failed');
    lifetime.fail(failure);
    lifetime.terminate();
    throw failure;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function loadTransformersEngine(
  options: LoadTransformersEngineOptions,
): Promise<TransformersEngineHandle> {
  const gpu = (globalThis.navigator as (Navigator & { readonly gpu?: TransformersGPU }) | undefined)
    ?.gpu;
  return createTransformersEngine(options, { gpu });
}
