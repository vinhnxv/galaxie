// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError, type ModelCall, type RunRequest } from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type StandardMessageStructure } from '@langchain/core/messages';
import { afterEach, expect, test, vi } from 'vitest';
import { createPyodideAdapter, type PyodideWorkerPort } from '../src/adapter.js';
import {
  BRIDGE_VERSION,
  type BridgeMessage,
  encodeBridge,
  failure,
  parseBridge,
  success,
} from '../src/bridge.js';

type MessageListener = (event: { readonly data: unknown }) => void;
class FixtureWorker implements PyodideWorkerPort {
  readonly sent: BridgeMessage[] = [];
  readonly listeners: Set<MessageListener> = new Set();
  readonly errors: Set<() => void> = new Set();
  pendingData: unknown = { interrupts: [] };
  terminated: boolean = false;
  bootAutomatically: boolean = true;
  handle: ((message: BridgeMessage) => void) | undefined;
  postMessage(raw: string): void {
    const message = parseBridge(raw);
    this.sent.push(message);
    if (message.kind === 'request' && message.op === 'boot' && this.bootAutomatically) {
      queueMicrotask(() =>
        this.emit(
          success(message, {
            coldStartMs: 3,
          }),
        ),
      );
    } else if (message.kind === 'request' && message.op === 'pending') {
      queueMicrotask(() => this.emit(success(message, this.pendingData)));
    } else this.handle?.(message);
  }
  emit(message: BridgeMessage): void {
    for (const listener of this.listeners) listener({ data: encodeBridge(message) });
  }
  addEventListener(type: 'message' | 'error', listener: MessageListener | (() => void)): void {
    if (type === 'message') this.listeners.add(listener as MessageListener);
    else this.errors.add(listener as () => void);
  }
  removeEventListener(type: 'message' | 'error', listener: MessageListener | (() => void)): void {
    if (type === 'message') this.listeners.delete(listener as MessageListener);
    else this.errors.delete(listener as () => void);
  }
  terminate(): void {
    this.terminated = true;
  }
}
const fixtureOrigin = typeof location === 'undefined' ? 'http://127.0.0.1:1234' : location.origin;
const descriptor = {
  baseUrl: `${fixtureOrigin}/agent/`,
  files: ['agent.py'],
  module: 'agent',
  entry: 'create_agent',
};
const preparation = {
  signal: new AbortController().signal,
  models: { roles: ['answer'], providers: { model: { credential: false } } },
};
function setup(workers: FixtureWorker[]): ReturnType<typeof createPyodideAdapter> {
  return createPyodideAdapter({
    createWorker: () => {
      const worker = new FixtureWorker();
      workers.push(worker);
      return worker;
    },
    runtimeUrl: '/local/pyodide/',
    wheelsUrl: `${fixtureOrigin}/wheels/`,
    localWheels: [],
  });
}
function model(text = 'checked reply'): BaseChatModel {
  return {
    invoke: vi.fn(
      async () =>
        new AIMessage<StandardMessageStructure>({
          content: text,
          usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        }),
    ),
  } as unknown as BaseChatModel;
}
function request(
  signal = new AbortController().signal,
  credential?: string,
): { request: RunRequest; lease: ModelCall } {
  const lease: ModelCall = {
    providerId: 'model',
    destination: 'in-browser',
    outputSafetyOutcome: undefined,
    ...(credential === undefined ? {} : { credential }),
    checkOutput: vi.fn(async () => {}),
    end: vi.fn(),
    fail: vi.fn(),
  };
  return {
    lease,
    request: {
      runId: 'run' as RunRequest['runId'],
      sessionId: 'session' as RunRequest['sessionId'],
      command: { type: 'start', input: { question: 'capital' } },
      signal,
      trace: {} as RunRequest['trace'],
      limits: { steps: 4 },
      models: { begin: vi.fn(async () => lease) },
      capabilities: { call: vi.fn(async () => ({ passages: [] })) },
    },
  };
}
async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of source) events.push(event);
  return events;
}
function modelRoundTrip(worker: FixtureWorker, capability = false): void {
  let run: BridgeMessage | undefined;
  worker.handle = (message) => {
    if (message.kind === 'request' && message.op === 'run') {
      run = message;
      worker.emit({
        v: BRIDGE_VERSION,
        kind: 'request',
        id: `${message.id}/1`,
        op: capability ? 'capability' : 'model',
        payload: capability
          ? {
              name: 'docs.search@1',
              input: { query: 'capital' },
              effectScope: 'parent:task|child:task',
            }
          : { role: 'answer', messages: [{ role: 'user', content: 'capital' }], options: {} },
      });
    } else if (message.kind === 'response' && message.op === 'capability' && run) {
      if (!message.ok) worker.emit(failure(run, message.error.code, 'result'));
      else
        worker.emit({
          v: BRIDGE_VERSION,
          kind: 'request',
          id: `${run.id}/2`,
          op: 'model',
          payload: {
            role: 'answer',
            messages: [{ role: 'user', content: 'capital' }],
            options: {},
          },
        });
    } else if (message.kind === 'response' && message.op === 'model' && run) {
      worker.emit(
        message.ok
          ? success(run, { output: message.payload }, 'result')
          : failure(run, message.error.code, 'result'),
      );
    }
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('validates descriptors and provider factories before fetching or constructing a Worker', async () => {
  const fetcher = vi.fn(async () => new Response('def create_agent(): pass'));
  vi.stubGlobal('fetch', fetcher);
  const workers: FixtureWorker[] = [];
  const adapter = setup(workers);
  expect(workers).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(adapter.features).toEqual({
    interrupts: true,
    resume: true,
    checkpoints: false,
    streaming: false,
    subgraphs: false,
  });
  await expect(
    adapter.prepare(
      { ...descriptor, files: ['../escape.py'] },
      { chatModels: { model: model() } },
      preparation,
    ),
  ).rejects.toMatchObject({ code: 'invalid' });
  await expect(adapter.prepare(descriptor, { chatModels: {} }, preparation)).rejects.toMatchObject({
    code: 'invalid',
  });
  await expect(
    adapter.prepare(descriptor, { chatModels: { model: () => model() } }, preparation),
  ).rejects.toMatchObject({ code: 'invalid' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(workers).toEqual([]);
});

test('routes capability task scopes and checked model replies while keeping credentials on the host', async () => {
  const fetcher = vi.fn(async () => new Response('def create_agent(): pass'));
  vi.stubGlobal('fetch', fetcher);
  const workers: FixtureWorker[] = [];
  const provider = model();
  const factory = vi.fn(() => provider);
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: factory } },
    { ...preparation, models: { roles: ['answer'], providers: { model: { credential: true } } } },
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  modelRoundTrip(worker, true);
  const run = request(undefined, 'HOST-ONLY-CREDENTIAL');
  expect(await collect(agent.run(run.request))).toEqual([
    {
      type: 'output',
      output: {
        content: 'checked reply',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ]);
  expect(fetcher).toHaveBeenCalledWith(
    new URL('agent.py', descriptor.baseUrl),
    expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
  );
  expect(run.request.capabilities.call).toHaveBeenCalledWith(
    'docs.search@1',
    { query: 'capital' },
    { signal: run.request.signal, effectScope: 'parent:task|child:task' },
  );
  expect(run.request.models.begin).toHaveBeenCalledWith('answer', { signal: run.request.signal });
  expect(factory).toHaveBeenCalledWith({ credential: 'HOST-ONLY-CREDENTIAL' });
  expect(run.lease.checkOutput).toHaveBeenCalledWith('checked reply', { final: true });
  expect(run.lease.end).toHaveBeenCalledWith({ inputTokens: 3, outputTokens: 2 });
  expect(run.lease.fail).not.toHaveBeenCalled();
  expect(JSON.stringify(worker.sent)).not.toContain('HOST-ONLY-CREDENTIAL');
  expect(await agent.pending('session' as RunRequest['sessionId'])).toBeUndefined();
  await agent.dispose();
  expect(worker.terminated).toBe(true);
});

test('optional provider token details do not change bridge usage totals', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const provider = {
    invoke: async () =>
      new AIMessage<StandardMessageStructure>({
        content: 'checked reply',
        usage_metadata: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          input_token_details: { cache_read: 1 },
          output_token_details: { reasoning: 1 },
        },
      }),
  } as unknown as BaseChatModel;
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: provider } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  modelRoundTrip(worker);
  const run = request();
  try {
    expect(await collect(agent.run(run.request))).toEqual([
      {
        type: 'output',
        output: {
          content: 'checked reply',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    ]);
    expect(run.lease.end).toHaveBeenCalledWith({ inputTokens: 3, outputTokens: 2 });
    expect(run.lease.fail).not.toHaveBeenCalled();
  } finally {
    await agent.dispose();
  }
});

test('a denied output never enters a Worker reply and preserves the fixed error code', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: model('BLOCKED-PRIVATE-REPLY') } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  modelRoundTrip(worker);
  const run = request();
  vi.mocked(run.lease.checkOutput).mockRejectedValue(
    new GalaxieError('denied', 'untrusted hook detail'),
  );
  expect(await collect(agent.run(run.request))).toEqual([
    { type: 'error', error: { code: 'denied', message: 'Policy denied the request.' } },
  ]);
  expect(JSON.stringify(worker.sent)).not.toContain('BLOCKED-PRIVATE-REPLY');
  expect(JSON.stringify(worker.sent)).not.toContain('untrusted hook detail');
  expect(run.lease.fail).toHaveBeenCalledOnce();
  expect(run.lease.end).not.toHaveBeenCalled();
  await agent.dispose();
});

test('broker failures cross as fixed codes without invoking the model', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const provider = model();
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: provider } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  modelRoundTrip(worker, true);
  const run = request();
  vi.mocked(run.request.capabilities.call).mockRejectedValue(
    new GalaxieError('invalid', 'private broker detail'),
  );
  expect(await collect(agent.run(run.request))).toEqual([
    { type: 'error', error: { code: 'invalid', message: 'The request is invalid.' } },
  ]);
  expect(provider.invoke).not.toHaveBeenCalled();
  expect(JSON.stringify(worker.sent)).not.toContain('private broker detail');
  await agent.dispose();
});

test('routed model failures preserve fixed codes without exposing provider details', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const provider = model();
  vi.mocked(provider.invoke).mockRejectedValue(
    new GalaxieError('unavailable', 'private provider detail'),
  );
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: provider } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  modelRoundTrip(worker);
  const run = request();
  expect(await collect(agent.run(run.request))).toEqual([
    {
      type: 'error',
      error: { code: 'unavailable', message: 'The requested service is unavailable.' },
    },
  ]);
  expect(run.lease.fail).toHaveBeenCalledOnce();
  expect(worker.sent.map(encodeBridge).join('\n')).not.toContain('private provider detail');
  await agent.dispose();
});

test.each(['start', 'resume'] as const)(
  'abort during %s settles while an uncooperative model reply is ignored',
  async (command) => {
    vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
    const workers: FixtureWorker[] = [];
    const delayed = Promise.withResolvers<AIMessage>();
    const invoke = vi.fn(() => delayed.promise);
    const provider = { invoke } as unknown as BaseChatModel;
    const agent = await setup(workers).prepare(
      descriptor,
      { chatModels: { model: provider } },
      preparation,
    );
    const worker = workers[0];
    if (!worker) throw new Error('Missing fixture Worker.');
    modelRoundTrip(worker);
    const original = worker.handle;
    worker.handle = (message) => {
      if (message.kind === 'request' && message.op === 'abort') worker.emit(success(message, null));
      else original?.(message);
    };
    const controller = new AbortController();
    const run = request(controller.signal);
    if (command === 'resume') {
      worker.pendingData = {
        interrupts: [{ id: 'one', value: interactionRequest }],
      };
      run.request = {
        ...run.request,
        command: { type: 'resume', interactionId: 'one' as never, action: 'submit', payload: {} },
      };
    }
    const events = collect(agent.run(run.request));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort();
    expect(await events).toEqual([]);
    expect(worker.terminated).toBe(true);
    await expect(agent.pending(run.request.sessionId)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(run.lease.fail).toHaveBeenCalledOnce();
    delayed.resolve(new AIMessage('LATE-REPLY'));
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(worker.sent)).not.toContain('LATE-REPLY');
    await agent.dispose();
  },
);

test('a nonresponsive Worker is terminated at the liveness bound and the next run boots fresh', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: model() } },
    preparation,
  );
  const first = workers[0];
  if (!first) throw new Error('Missing fixture Worker.');
  const controller = new AbortController();
  const running = collect(agent.run(request(controller.signal).request));
  await vi.waitFor(() => expect(first.sent.some((message) => message.op === 'run')).toBe(true));
  vi.useFakeTimers();
  controller.abort();
  await vi.advanceTimersByTimeAsync(499);
  expect(first.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await running).toEqual([]);
  expect(first.terminated).toBe(true);
  vi.useRealTimers();
  const next = collect(agent.run(request().request));
  await vi.waitFor(() => expect(workers).toHaveLength(2));
  const second = workers[1];
  if (!second) throw new Error('Missing replacement Worker.');
  await vi.waitFor(() => expect(second.sent.some((message) => message.op === 'run')).toBe(true));
  const run = second.sent.find((message) => message.kind === 'request' && message.op === 'run');
  if (!run) throw new Error('Missing replacement run.');
  second.emit(success(run, { output: { recovered: true } }, 'result'));
  expect(await next).toEqual([{ type: 'output', output: { recovered: true } }]);
  await agent.dispose();
});

test('cancelling preparation terminates a Worker whose boot has not completed', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const worker = new FixtureWorker();
  worker.bootAutomatically = false;
  const controller = new AbortController();
  const adapter = createPyodideAdapter({
    createWorker: () => worker,
    runtimeUrl: '/local/pyodide/',
    wheelsUrl: `${fixtureOrigin}/wheels/`,
    localWheels: [],
  });
  const prepared = adapter.prepare(
    descriptor,
    { chatModels: { model: model() } },
    { ...preparation, signal: controller.signal },
  );
  const rejected = expect(prepared).rejects.toMatchObject({
    code: 'cancelled',
    message: 'The operation was cancelled.',
  });
  await vi.waitFor(() => expect(worker.sent.some((message) => message.op === 'boot')).toBe(true));
  controller.abort();
  await rejected;
  expect(worker.terminated).toBe(true);
});

test.each([
  '{"v":"unknown","secret":"private worker detail"}',
  '{"v":"galaxie.bridge/v1","kind":"response","id":"run-2","op":"result","ok":true,"payload":{"output":{}}}',
  '{"v":"galaxie.bridge/v2","kind":"request","id":"one","op":"unknown","payload":{}}',
  '{"v":"galaxie.bridge/v2","kind":"notify","id":"one","op":"stream","payload":[[],"updates",{}]}',
])('an invalid or unexpected Worker envelope terminates the connection: %s', async (raw) => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: model() } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  const running = collect(agent.run(request().request));
  await vi.waitFor(() => expect(worker.sent.some((message) => message.op === 'run')).toBe(true));
  for (const listener of worker.listeners) listener({ data: raw });
  expect(await running).toEqual([
    { type: 'error', error: { code: 'invalid', message: 'The request is invalid.' } },
  ]);
  expect(worker.terminated).toBe(true);
  await agent.dispose();
});

const interactionRequest = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'conformance.Question/v1',
  props: { question: 'Continue?' },
};

test('reads committed pending state, resumes by ID and refuses an already answered interaction', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: model() } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  worker.handle = (message) => {
    if (message.kind !== 'request' || message.op !== 'run') return;
    const payload = message.payload as { resume?: unknown; threadId: string };
    expect(payload.threadId).toBe('session');
    if (payload.resume) {
      expect(payload.resume).toEqual({
        interactionId: 'pending-id',
        action: 'submit',
        payload: false,
      });
      worker.pendingData = { interrupts: [] };
      worker.emit(success(message, { output: { answer: false } }, 'result'));
    } else {
      worker.pendingData = {
        interrupts: [{ id: 'pending-id', value: interactionRequest }],
      };
      worker.emit(success(message, { interrupted: true }, 'result'));
    }
  };
  const initial = request().request;
  expect(await collect(agent.run(initial))).toEqual([
    {
      type: 'interaction',
      interaction: {
        interactionId: 'pending-id',
        ...interactionRequest,
      },
    },
  ]);
  expect(await agent.pending(initial.sessionId)).toEqual({
    interactionId: 'pending-id',
    ...interactionRequest,
  });
  const resumed: RunRequest = {
    ...initial,
    command: {
      type: 'resume',
      interactionId: 'pending-id' as never,
      action: 'submit',
      payload: false,
    },
  };
  expect(await collect(agent.run(resumed))).toEqual([
    { type: 'output', output: { answer: false } },
  ]);
  expect(await agent.pending(initial.sessionId)).toBeUndefined();
  expect(await collect(agent.run(resumed))).toEqual([
    {
      type: 'error',
      error: {
        code: 'unsupported',
        message: 'This operation is unsupported.',
      },
    },
  ]);
  expect(worker.sent.filter((message) => message.op === 'run')).toHaveLength(2);
  await agent.dispose();
});

test('pending rejects parallel, ID-less and static interrupts and validates the request in JavaScript', async () => {
  vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
  const workers: FixtureWorker[] = [];
  const agent = await setup(workers).prepare(
    descriptor,
    { chatModels: { model: model() } },
    preparation,
  );
  const worker = workers[0];
  if (!worker) throw new Error('Missing fixture Worker.');
  for (const interrupts of [
    [
      { id: 'one', value: interactionRequest },
      { id: 'two', value: interactionRequest },
    ],
    [{ value: interactionRequest }],
  ]) {
    worker.pendingData = { interrupts };
    await expect(agent.pending('session' as never)).rejects.toMatchObject({ code: 'unsupported' });
  }
  worker.pendingData = {
    interrupts: [{ id: 'one', value: { ...interactionRequest, component: 'invalid' } }],
  };
  await expect(agent.pending('session' as never)).rejects.toMatchObject({ code: 'invalid' });
  worker.pendingData = { interrupts: [] };
  expect(await agent.pending('session' as never)).toBeUndefined();
  worker.handle = (message) => {
    if (message.kind === 'request' && message.op === 'run')
      worker.emit(success(message, { interrupted: true }, 'result'));
  };
  expect(await collect(agent.run(request().request))).toEqual([
    { type: 'error', error: { code: 'unsupported', message: 'This operation is unsupported.' } },
  ]);
  await agent.dispose();
});

test.each(['abort', 'crash'] as const)(
  'lost paused state after %s fails unavailable without booting a fresh Worker',
  async (reason) => {
    vi.stubGlobal('fetch', async () => new Response('def create_agent(): pass'));
    const workers: FixtureWorker[] = [];
    const agent = await setup(workers).prepare(
      descriptor,
      { chatModels: { model: model() } },
      preparation,
    );
    const worker = workers[0];
    if (!worker) throw new Error('Missing fixture Worker.');
    worker.handle = (message) => {
      if (message.kind === 'request' && message.op === 'run') {
        worker.pendingData = {
          interrupts: [{ id: 'one', value: interactionRequest }],
        };
        worker.emit(success(message, { interrupted: true }, 'result'));
      }
    };
    const controller = new AbortController();
    const initial = request(controller.signal).request;
    expect(await collect(agent.run(initial))).toHaveLength(1);
    if (reason === 'abort') controller.abort();
    else for (const error of worker.errors) error();
    await expect(agent.pending(initial.sessionId)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    expect(
      await collect(
        agent.run({
          ...request().request,
          command: { type: 'resume', interactionId: 'one' as never, action: 'submit', payload: {} },
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: { code: 'unavailable', message: 'The requested service is unavailable.' },
      },
    ]);
    expect(workers).toHaveLength(1);
    await agent.dispose();
  },
);
