// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ModelError, ModelProviderError } from '../src/errors.js';
import { classifyTransformersError } from '../src/transformers/classify.js';
import {
  createTransformersEngine,
  type TransformersEngineHandle,
  type TransformersGPU,
  type TransformersStreamEvent,
} from '../src/transformers/engine.js';
import type { GenerateRequest } from '../src/transformers/protocol.js';
import {
  FakeTransformersWorker,
  request,
  settle,
  wasmDevice,
} from './support/fake-transformers-worker.js';
import { createSyntheticModel } from './support/transformers-model.js';

async function ready(): Promise<{
  worker: FakeTransformersWorker;
  handle: TransformersEngineHandle;
}> {
  const { record } = await createSyntheticModel();
  const worker = new FakeTransformersWorker();
  const loading = createTransformersEngine({ worker, model: record }, { gpu: undefined });
  await settle();
  worker.emit({ type: 'ready', device: wasmDevice });
  return { worker, handle: await loading };
}

async function collect(
  iterable: AsyncGenerator<TransformersStreamEvent>,
): Promise<TransformersStreamEvent[]> {
  const events: TransformersStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const finish = (id: number): Record<string, unknown> => ({
  type: 'done',
  id,
  usage: { promptTokens: 1, completionTokens: 2 },
  finishReason: 'stop',
});

describe('stream turns', () => {
  it('runs concurrent streams in arrival order', async () => {
    const { worker, handle } = await ready();
    const first = collect(handle.stream(request as GenerateRequest));
    const second = collect(handle.stream(request as GenerateRequest));
    await settle();
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1]);
    worker.emit({ type: 'chunk', id: 1, text: 'a' });
    worker.emit(finish(1));
    expect(await first).toEqual([
      { type: 'chunk', text: 'a' },
      { type: 'done', usage: { promptTokens: 1, completionTokens: 2 }, finishReason: 'stop' },
    ]);
    await settle();
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1, 2]);
    worker.emit(finish(2));
    expect((await second).at(-1)?.type).toBe('done');
  });

  it('ignores chunks that belong to another request', async () => {
    const { worker, handle } = await ready();
    const run = collect(handle.stream(request as GenerateRequest));
    await settle();
    worker.emit({ type: 'chunk', id: 99, text: 'stale' });
    worker.emit({ type: 'chunk', id: 1, text: 'mine' });
    worker.emit(finish(1));
    expect((await run).filter((event) => event.type === 'chunk')).toEqual([
      { type: 'chunk', text: 'mine' },
    ]);
  });

  it('rejects a queued stream aborted before its turn without posting generate', async () => {
    const { worker, handle } = await ready();
    const first = collect(handle.stream(request as GenerateRequest));
    const controller = new AbortController();
    const second = collect(handle.stream(request as GenerateRequest, controller.signal));
    const outcome = second.then(
      () => 'ok',
      (error: unknown) => error,
    );
    await settle();
    controller.abort(new Error('cancelled'));
    expect(await outcome).toEqual(new Error('cancelled'));
    worker.emit(finish(1));
    await first;
    await settle();
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1]);
  });

  it('rejects a stream whose signal is already aborted without posting anything', async () => {
    const { worker, handle } = await ready();
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(
      collect(handle.stream(request as GenerateRequest, controller.signal)),
    ).rejects.toThrow('early');
    expect(worker.of('generate')).toEqual([]);
  });

  it('aborts mid-stream at once and releases the next turn only after done', async () => {
    const { worker, handle } = await ready();
    const controller = new AbortController();
    const first = collect(handle.stream(request as GenerateRequest, controller.signal));
    const firstOutcome = first.then(
      () => 'ok',
      (error: unknown) => error,
    );
    const second = collect(handle.stream(request as GenerateRequest));
    await settle();
    controller.abort(new Error('stop now'));
    expect(await firstOutcome).toEqual(new Error('stop now'));
    expect(worker.of('abort')).toEqual([{ type: 'abort', id: 1 }]);
    await settle();
    // The Worker has not answered yet, so the next request must still be waiting.
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1]);
    worker.emit({
      type: 'done',
      id: 1,
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'abort',
    });
    await settle();
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1, 2]);
    worker.emit(finish(2));
    expect((await second).at(-1)?.type).toBe('done');
  });

  it('releases the turn after an abort even when the consumer never resumes the stream', async () => {
    const { worker, handle } = await ready();
    const controller = new AbortController();
    const abandoned = handle.stream(request as GenerateRequest, controller.signal);
    // The first pull posts the request and waits for chunks.
    const pending = abandoned.next();
    const second = collect(handle.stream(request as GenerateRequest));
    await settle();
    worker.emit({ type: 'chunk', id: 1, text: 'a' });
    expect((await pending).value).toEqual({ type: 'chunk', text: 'a' });
    controller.abort(new Error('stop now'));
    // Nothing resumes `abandoned`: the abort alone must end the turn once the Worker answers.
    await settle();
    expect(worker.of('abort')).toEqual([{ type: 'abort', id: 1 }]);
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1]);
    worker.emit({
      type: 'done',
      id: 1,
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'abort',
    });
    await settle();
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1, 2]);
    worker.emit(finish(2));
    expect((await second).at(-1)?.type).toBe('done');
  });

  it('releases the next turn after a failed message for an aborted request', async () => {
    const { worker, handle } = await ready();
    const controller = new AbortController();
    const first = collect(handle.stream(request as GenerateRequest, controller.signal)).catch(
      () => undefined,
    );
    const second = collect(handle.stream(request as GenerateRequest));
    await settle();
    controller.abort(new Error('x'));
    await first;
    worker.emit({ type: 'failed', id: 1, code: 'provider' });
    await settle();
    expect(worker.of('generate').map((message) => message['id'])).toEqual([1, 2]);
    worker.emit(finish(2));
    await second;
  });
});

describe('failures', () => {
  it('fails the handle once on a Worker error and posts nothing afterwards', async () => {
    const { worker, handle } = await ready();
    const run = collect(handle.stream(request as GenerateRequest));
    const outcome = run.then(
      () => 'ok',
      (error: unknown) => error,
    );
    await settle();
    worker.fail();
    const error = await outcome;
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).reason).toBe('worker_failed');
    const before = worker.posted.length;
    await expect(collect(handle.stream(request as GenerateRequest))).rejects.toMatchObject({
      reason: 'worker_failed',
    });
    expect(worker.posted.length).toBe(before);
    expect(worker.terminated).toBe(1);
  });

  it('settles an active stream and terminates once on dispose', async () => {
    const { worker, handle } = await ready();
    const run = collect(handle.stream(request as GenerateRequest)).then(
      () => 'ok',
      (error: unknown) => error,
    );
    await settle();
    await handle.dispose();
    await handle.dispose();
    const error = await run;
    expect((error as ModelError).reason).toBe('disposed');
    expect(worker.terminated).toBe(1);
    expect(worker.of('dispose')).toHaveLength(1);
    await expect(collect(handle.stream(request as GenerateRequest))).rejects.toMatchObject({
      reason: 'disposed',
    });
  });

  it('maps failed codes to fixed errors and unknown shapes to the provider error', async () => {
    const cases: [Record<string, unknown>, (error: unknown) => void][] = [
      [
        { type: 'failed', id: 1, code: 'invalid' },
        (error) => expect(error).toMatchObject({ code: 'invalid' }),
      ],
      [
        { type: 'failed', id: 1, code: 'provider' },
        (error) => expect(error).toBeInstanceOf(ModelProviderError),
      ],
      [
        { type: 'failed', id: 1, code: 'martian', message: 'leaked prompt text' },
        (error) => {
          expect(error).toBeInstanceOf(ModelProviderError);
          expect(String((error as Error).message)).not.toContain('leaked');
        },
      ],
    ];
    for (const [message, check] of cases) {
      const { worker, handle } = await ready();
      const run = collect(handle.stream(request as GenerateRequest)).then(
        () => 'ok',
        (error: unknown) => error,
      );
      await settle();
      worker.emit(message);
      check(await run);
    }
  });

  it('stops accepting requests after an unavailable failure', async () => {
    const { worker, handle } = await ready();
    const run = collect(handle.stream(request as GenerateRequest)).catch((error: unknown) => error);
    await settle();
    worker.emit({ type: 'failed', id: 1, code: 'unavailable', reason: 'device_lost' });
    expect(await run).toMatchObject({ reason: 'device_lost' });
    await expect(collect(handle.stream(request as GenerateRequest))).rejects.toMatchObject({
      reason: 'device_lost',
    });
  });
});

describe('classifyTransformersError', () => {
  it('maps runtime failures to fixed codes', () => {
    expect(classifyTransformersError(new RangeError('Array buffer allocation failed'))).toEqual({
      code: 'unavailable',
      reason: 'load_failed',
    });
    expect(classifyTransformersError(new Error('GPUDevice was lost'))).toEqual({
      code: 'unavailable',
      reason: 'device_lost',
    });
    expect(classifyTransformersError(new Error('device does not support shader-f16'))).toEqual({
      code: 'unavailable',
      reason: 'no_shader_f16',
    });
    expect(classifyTransformersError(new ModelError('invalid'))).toEqual({ code: 'invalid' });
    expect(classifyTransformersError(new ModelError('unavailable', 'integrity'))).toEqual({
      code: 'unavailable',
      reason: 'integrity',
    });
    expect(classifyTransformersError(new Error('something odd'))).toBeUndefined();
    expect(classifyTransformersError('text')).toBeUndefined();
  });
});

describe('createTransformersEngine', () => {
  const gpu = (features: string[] | null): TransformersGPU => ({
    requestAdapter: async () =>
      features === null
        ? null
        : { features: { has: (name: string) => features.includes(name) }, info: {} },
  });

  it('reports progress and returns a handle with the device report', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    const progress: string[] = [];
    const loading = createTransformersEngine(
      {
        worker,
        model: record,
        allowDownload: true,
        onProgress: (item) => progress.push(item.phase),
      },
      { gpu: undefined },
    );
    await settle();
    expect(worker.posted[0]).toMatchObject({ type: 'load', allowDownload: true });
    worker.emit({ type: 'progress', phase: 'download', fraction: 0.2, elapsedSeconds: 1 });
    worker.emit({ type: 'progress', phase: 'verify', fraction: 1, elapsedSeconds: 2 });
    worker.emit({ type: 'progress', phase: 'load', fraction: 1, elapsedSeconds: 3 });
    worker.emit({ type: 'ready', device: wasmDevice });
    const handle = await loading;
    expect(progress).toEqual(['download', 'verify', 'load']);
    expect(handle.device).toEqual(wasmDevice);
    expect(Object.isFrozen(handle.device)).toBe(true);
  });

  it('fails before asking the Worker to load when WebGPU is missing', async () => {
    const { record } = await createSyntheticModel();
    const webgpu = { ...record, device: 'webgpu' as const, dtype: 'q4' as const };
    const worker = new FakeTransformersWorker();
    await expect(
      createTransformersEngine({ worker, model: webgpu }, { gpu: undefined }),
    ).rejects.toMatchObject({ reason: 'no_webgpu' });
    await expect(
      createTransformersEngine({ worker, model: webgpu }, { gpu: gpu(null) }),
    ).rejects.toMatchObject({ reason: 'no_adapter' });
    expect(worker.posted).toEqual([]);
    expect(worker.terminated).toBe(2);
  });

  it('requires shader-f16 for f16 dtypes only', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    await expect(
      createTransformersEngine(
        { worker, model: { ...record, device: 'webgpu', dtype: 'q4f16' } },
        { gpu: gpu([]) },
      ),
    ).rejects.toMatchObject({ reason: 'no_shader_f16' });
    const next = new FakeTransformersWorker();
    const loading = createTransformersEngine(
      { worker: next, model: { ...record, device: 'webgpu', dtype: 'q4' } },
      { gpu: gpu([]) },
    );
    await settle();
    expect(next.of('load')).toHaveLength(1);
    next.emit({ type: 'ready', device: { ...wasmDevice, backend: 'webgpu' } });
    await loading;
  });

  it('loads a wasm record without probing WebGPU', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    let probed = 0;
    const loading = createTransformersEngine(
      { worker, model: record },
      {
        gpu: {
          requestAdapter: async () => {
            probed += 1;
            return null;
          },
        },
      },
    );
    await settle();
    worker.emit({ type: 'ready', device: wasmDevice });
    await loading;
    expect(probed).toBe(0);
  });

  it('fails an integrity error from the Worker and terminates it', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    const loading = createTransformersEngine({ worker, model: record }, { gpu: undefined });
    await settle();
    worker.emit({ type: 'failed', code: 'unavailable', reason: 'integrity' });
    await expect(loading).rejects.toMatchObject({ code: 'unavailable', reason: 'integrity' });
    expect(worker.terminated).toBe(1);
  });

  it('fails with the signal reason when aborted during load and terminates the Worker', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    const controller = new AbortController();
    const loading = createTransformersEngine(
      { worker, model: record, signal: controller.signal },
      { gpu: undefined },
    );
    await settle();
    controller.abort(new Error('user cancelled'));
    await expect(loading).rejects.toThrow('user cancelled');
    expect(worker.terminated).toBe(1);
  });

  it('rejects a ready message whose backend differs from the record', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    const loading = createTransformersEngine({ worker, model: record }, { gpu: undefined });
    await settle();
    worker.emit({ type: 'ready', device: { ...wasmDevice, backend: 'webgpu' } });
    await expect(loading).rejects.toMatchObject({ reason: 'load_failed' });
  });

  it('fails an invalid record without touching the Worker', async () => {
    const { record } = await createSyntheticModel();
    const worker = new FakeTransformersWorker();
    await expect(
      createTransformersEngine(
        { worker, model: { ...record, revision: 'main' } },
        { gpu: undefined },
      ),
    ).rejects.toBeDefined();
    expect(worker.posted).toEqual([]);
  });
});
