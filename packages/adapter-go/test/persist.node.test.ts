// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ExecutorAgent, ExecutorEvent } from '@galaxie-ai/core';
import { expect, test, vi } from 'vitest';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { loadConversation, saveConversation } from '../src/checkpoints.js';
import { createGoAdapter, type GoAgent } from '../src/index.js';
import { decodeStored, encodeStored, restoredContent, revisionId } from '../src/persist.js';
import type { WorkerMessage } from '../src/protocol.js';
import { approvalRequest, FakeGoWorker, failResult, type Program } from './support-go.js';

const agent: GoAgent = {
  wasm: { url: 'http://127.0.0.1/go/agent.wasm', sha256: 'a'.repeat(64), bytes: 1024 },
  entry: 'reference',
};
const digest = (digit: string): string => digit.repeat(64);
const start = { type: 'start', input: { prompt: 'go' } };
const resume = (interactionId: string): unknown => ({
  type: 'resume',
  interactionId,
  action: 'approve',
  payload: { indexes: [0] },
});

/** A closed-shape record the way the program returns it, holding one pause on `id`. */
function record(events: number, id?: string): Record<string, unknown> {
  return {
    v: 1,
    conversation: 'g1',
    ordinal: 1,
    counter: events,
    memory: {},
    events: Array.from({ length: events }, (_, index) => ({
      id: `e${index}`,
      timestamp: 1,
      author: 'user',
      content: { role: 'user', parts: [{ text: `PRIVATE-${index}` }] },
    })),
    ...(id === undefined
      ? {}
      : {
          pause: {
            id,
            request: approvalRequest,
            calls: [{ id: 'c1', name: 'x', request: { value: 'PRIVATE-CALL' } }],
          },
        }),
  };
}
const paused = (id: string, events = 1): string =>
  JSON.stringify({
    ok: true,
    paused: { interactionId: id, request: approvalRequest },
    record: record(events, id),
  });
const finished = (events = 2): string =>
  JSON.stringify({ ok: true, output: 'answered', record: record(events) });

/** A Worker that dies in the same turn its run result arrives. */
class DyingWorker extends FakeGoWorker {
  override emit(message: WorkerMessage): void {
    super.emit(message);
    if (message.kind === 'done') this.fail();
  }
}

interface Setup {
  readonly worker: FakeGoWorker;
  readonly executor: ExecutorAgent;
  readonly register: ReturnType<typeof vi.fn>;
}
async function open(
  program: Program,
  checkpoints: { request(value: unknown): Promise<unknown> } | undefined,
  worker: FakeGoWorker = new FakeGoWorker(program),
): Promise<Setup> {
  const executor = await createGoAdapter({ createWorker: () => worker }).prepare(
    agent,
    { chatModels: {}, ...(checkpoints === undefined ? {} : { checkpoints }) },
    { signal: new AbortController().signal },
  );
  return { worker, executor, register: vi.fn() };
}
async function drain(
  setup: Setup,
  command: unknown,
  options: { sessionId?: string; signal?: AbortSignal; register?: boolean } = {},
): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  for await (const event of setup.executor.run({
    signal: options.signal ?? new AbortController().signal,
    sessionId: options.sessionId ?? 's',
    command,
    ...(options.register === false ? {} : { registerRestoredData: setup.register }),
  } as never))
    events.push(event);
  return events;
}
const pendingOf = (setup: Setup, register = true): Promise<unknown> =>
  setup.executor.pending(
    's' as never,
    register ? ({ registerRestoredData: setup.register } as never) : undefined,
  );
const runs = (worker: FakeGoWorker): Array<Record<string, unknown>> =>
  worker.received
    .filter((message) => message.kind === 'run')
    .map((message) => JSON.parse(message.request) as Record<string, unknown>);

/** A program that pauses on a prompt and finishes on an answer. */
const pausing: Program = async (api) =>
  api.request.resume === undefined ? paused(digest('1')) : finished();

test('a run asks for a record only when the host has a store', async () => {
  const plain = await open(pausing, undefined);
  await drain(plain, start);
  expect(runs(plain.worker)[0]).not.toHaveProperty('persist');

  const store = new MemoryByteCheckpoints();
  const durable = await open(pausing, store);
  await drain(durable, start);
  expect(runs(durable.worker)[0]).toMatchObject({ persist: true });
  expect(runs(durable.worker)[0]).not.toHaveProperty('restore');
});

test('a pause is stored, a resume carries the stored record and completion replaces it', async () => {
  const store = new MemoryByteCheckpoints();
  const setup = await open(pausing, store);
  expect(await drain(setup, start)).toMatchObject([{ type: 'interaction' }]);
  expect(store.rows.size).toBe(1);
  expect(await drain(setup, resume(digest('1')))).toEqual([{ type: 'output', output: 'answered' }]);
  const sent = runs(setup.worker);
  expect(sent[1]).toMatchObject({ persist: true, restore: record(1, digest('1')) });
  expect(store.rows.size).toBe(2);
  const latest = [...store.rows.values()].sort((a, b) => b.id.localeCompare(a.id))[0];
  expect(JSON.parse(new TextDecoder().decode(latest?.checkpoint.bytes))).toEqual(record(2));
  await expect(pendingOf(setup)).resolves.toBeUndefined();
});

test('the marker is written before the commit and names the pending interaction', async () => {
  const store = new MemoryByteCheckpoints();
  const order: string[] = [];
  const spying = {
    request: async (value: unknown): Promise<unknown> => {
      const op = (value as { op: string }).op;
      order.push(op);
      if (op === 'put-writes')
        expect((value as { writes: Array<{ interruptIds: string[] }> }).writes[0]).toMatchObject({
          interruptIds: [digest('1')],
        });
      return store.request(value);
    },
  };
  const setup = await open(pausing, spying);
  await drain(setup, start);
  expect(order.filter((op) => op !== 'get')).toEqual(['put-writes', 'put']);
});

test('a fresh instance restores the pause from the record alone and resumes it', async () => {
  const store = new MemoryByteCheckpoints();
  const first = await open(pausing, store);
  await drain(first, start);
  await first.executor.dispose();

  const second = await open(pausing, store);
  await expect(pendingOf(second)).resolves.toMatchObject({
    interactionId: digest('1'),
  });
  // The restored history is registered as private before the program can replay it.
  expect(second.register).toHaveBeenCalled();
  expect(JSON.stringify(second.register.mock.calls)).toContain('PRIVATE-0');
  expect(JSON.stringify(second.register.mock.calls)).toContain('PRIVATE-CALL');
  expect(await drain(second, resume(digest('1')))).toEqual([
    { type: 'output', output: 'answered' },
  ]);
  expect(runs(second.worker)[0]).toMatchObject({
    conversation: 'g1',
    restore: record(1, digest('1')),
  });
});

test('a restored conversation is registered as private again for every run that replays it', async () => {
  const store = new MemoryByteCheckpoints();
  const first = await open(pausing, store);
  await drain(first, start);
  const second = await open(pausing, store);
  await drain(second, resume(digest('1')));
  const registered = second.register.mock.calls.length;
  expect(registered).toBeGreaterThanOrEqual(2);
});

test('a restore without the registration hook fails unsupported rather than expose the text', async () => {
  const store = new MemoryByteCheckpoints();
  const first = await open(pausing, store);
  await drain(first, start);
  const second = await open(pausing, store);
  await expect(pendingOf(second, false)).rejects.toMatchObject({ code: 'unsupported' });
});

test('a run that fails after taking the pause leaves the stored pause answerable', async () => {
  const store = new MemoryByteCheckpoints();
  let calls = 0;
  const flaky: Program = async (api) => {
    if (api.request.resume === undefined) return paused(digest('1'));
    calls += 1;
    return calls === 1 ? failResult('unavailable') : finished();
  };
  const setup = await open(flaky, store);
  await drain(setup, start);
  const before = store.rows.size;
  expect(await drain(setup, resume(digest('1')))).toMatchObject([
    { type: 'error', error: { code: 'unavailable' } },
  ]);
  expect(store.rows.size).toBe(before);
  await expect(pendingOf(setup)).resolves.toMatchObject({
    interactionId: digest('1'),
  });
  expect(await drain(setup, resume(digest('1')))).toEqual([{ type: 'output', output: 'answered' }]);
});

test('a cancelled resume leaves the stored pause answerable', async () => {
  const store = new MemoryByteCheckpoints();
  const waiting = Promise.withResolvers<void>();
  const slow: Program = async (api) => {
    if (api.request.resume === undefined) return paused(digest('1'));
    waiting.resolve();
    await api.cancelled;
    return failResult('cancelled');
  };
  const setup = await open(slow, store);
  await drain(setup, start);
  const abort = new AbortController();
  const pending = drain(setup, resume(digest('1')), { signal: abort.signal });
  await waiting.promise;
  abort.abort();
  await pending;
  await expect(pendingOf(setup)).resolves.toMatchObject({
    interactionId: digest('1'),
  });
});

test('a Worker that dies between the run result and the page recording the pause still pauses with a store', async () => {
  const store = new MemoryByteCheckpoints();
  const worker = new DyingWorker(async () => paused(digest('1')));
  const setup = await open(async () => paused(digest('1')), store, worker);
  expect(await drain(setup, start)).toMatchObject([
    { type: 'interaction', interaction: { interactionId: digest('1') } },
  ]);
  expect(store.rows.size).toBe(1);
  // The Worker is gone, but the record is stored: a new instance continues the pause.
  const next = await open(pausing, store);
  await expect(pendingOf(next)).resolves.toMatchObject({
    interactionId: digest('1'),
  });
  expect(await drain(next, resume(digest('1')))).toEqual([{ type: 'output', output: 'answered' }]);
});

test('a Worker that dies between the run result and the page recording the pause loses it without a store', async () => {
  const bare = JSON.stringify({
    ok: true,
    paused: { interactionId: digest('1'), request: approvalRequest },
  });
  const worker = new DyingWorker(async () => bare);
  const setup = await open(async () => bare, undefined, worker);
  expect(await drain(setup, start)).toMatchObject([
    { type: 'error', error: { code: 'unavailable' } },
  ]);
  await expect(pendingOf(setup)).resolves.toBeUndefined();
});

test('a store that rejects the commit fails the run and publishes no pause', async () => {
  const broken = {
    request: async (value: unknown): Promise<unknown> => {
      if ((value as { op: string }).op === 'get') return null;
      throw new Error('PRIVATE STORAGE DETAIL');
    },
  };
  const setup = await open(pausing, broken);
  const events = await drain(setup, start);
  expect(events).toMatchObject([{ type: 'error', error: { code: 'unavailable' } }]);
  expect(JSON.stringify(events)).not.toContain('PRIVATE STORAGE DETAIL');
  await expect(pendingOf(setup)).resolves.toBeUndefined();
});

test('a program that returns no record for a store fails invalid', async () => {
  const store = new MemoryByteCheckpoints();
  const setup = await open(async () => JSON.stringify({ ok: true, output: 'no record' }), store);
  expect(await drain(setup, start)).toMatchObject([{ type: 'error', error: { code: 'invalid' } }]);
});

test('a program that returns a record to a host with no store fails invalid', async () => {
  const setup = await open(async () => finished(), undefined);
  expect(await drain(setup, start)).toMatchObject([{ type: 'error', error: { code: 'invalid' } }]);
});

async function tampered(
  edit: (stored: {
    id: string;
    checkpoint: Uint8Array;
    metadata: Uint8Array;
  }) => Promise<void> | void,
): Promise<unknown> {
  const store = new MemoryByteCheckpoints();
  const body = record(1, digest('1'));
  await saveConversation(store, 's', 0, new Uint8Array(32).fill(7), body, 0, digest('1'));
  await expect(loadConversation(store, 's')).resolves.toMatchObject({ record: body, revision: 1 });
  const [row] = [...store.rows.values()];
  if (row === undefined) throw new Error('No record was stored.');
  const bytes = { id: row.id, checkpoint: row.checkpoint.bytes, metadata: row.metadata.bytes };
  await edit(bytes);
  store.rows.set(JSON.stringify(['s', '', bytes.id]), {
    ...row,
    id: bytes.id,
    checkpoint: { ...row.checkpoint, bytes: bytes.checkpoint },
    metadata: { ...row.metadata, bytes: bytes.metadata },
  });
  const second = await open(pausing, store);
  return pendingOf(second);
}

test('a corrupt record fails unrecoverable before any program sees it', async () => {
  await expect(
    tampered((stored) => {
      stored.checkpoint = new TextEncoder().encode('{"v":1');
    }),
  ).rejects.toMatchObject({ code: 'unrecoverable' });
});

test('a record edited without the key fails the integrity tag', async () => {
  await expect(
    tampered((stored) => {
      const text = new TextDecoder().decode(stored.checkpoint).replace('PRIVATE-0', 'FORGED-00');
      stored.checkpoint = new TextEncoder().encode(text);
    }),
  ).rejects.toMatchObject({ code: 'unrecoverable' });
});

test('a saved record copied to the next revision fails unrecoverable', async () => {
  await expect(
    tampered((stored) => {
      stored.id = revisionId(2);
    }),
  ).rejects.toMatchObject({ code: 'unrecoverable' });
});

test('a record stored under another session fails the integrity tag', async () => {
  const store = new MemoryByteCheckpoints();
  const first = await open(pausing, store);
  await drain(first, start, { sessionId: 'other' });
  const [row] = [...store.rows.values()];
  if (row === undefined) throw new Error('No record was stored.');
  store.rows.set(JSON.stringify(['s', '', row.id]), { ...row, sessionId: 's' });
  const second = await open(pausing, store);
  await expect(pendingOf(second)).rejects.toMatchObject({
    code: 'unrecoverable',
  });
});

test('a record with unknown keys fails even under a valid tag', async () => {
  const key = new Uint8Array(32).fill(7);
  const body = { ...record(1, digest('1')), extra: true };
  const { checkpoint, metadata } = await encodeStored('s', revisionId(1), body as never, 0, key);
  await expect(
    decodeStored('s', {
      id: '00000000000000000001',
      checkpoint: { type: 'adk-go.session/v1', bytes: checkpoint },
      metadata: { type: 'galaxie.adk-go-state/v1', bytes: metadata },
    }),
  ).rejects.toMatchObject({ code: 'unrecoverable' });
});

test('a record above the size limit is refused unsupported before it is stored', async () => {
  const store = new MemoryByteCheckpoints();
  const huge = JSON.stringify({
    ok: true,
    output: 'x',
    record: { ...record(1), memory: { big: 'x'.repeat(600 * 1024) } },
  });
  const setup = await open(async () => huge, store);
  expect(await drain(setup, start)).toMatchObject([
    { type: 'error', error: { code: 'unsupported' } },
  ]);
  expect(store.rows.size).toBe(0);
});

test('a Worker ended by the cancel bound leaves the stored pause for the next instance', async () => {
  const store = new MemoryByteCheckpoints();
  const entered = Promise.withResolvers<void>();
  const stuck: Program = async (api) => {
    if (api.request.resume === undefined) return paused(digest('1'));
    entered.resolve();
    // The program ignores the cancel message, so only the page's bound can end the run.
    await new Promise<never>(() => {});
    return failResult('cancelled');
  };
  const worker = new FakeGoWorker(stuck, { silentOnCancel: true });
  const first = await open(stuck, store, worker);
  await drain(first, start);
  const abort = new AbortController();
  const running = drain(first, resume(digest('1')), { signal: abort.signal });
  await entered.promise;
  abort.abort();
  await running;
  expect(worker.terminated).toBe(true);
  // The Worker is gone, yet the record still describes the pause the aborted run had taken.
  await expect(pendingOf(first)).resolves.toMatchObject({ interactionId: digest('1') });
  await first.executor.dispose();

  const second = await open(pausing, store);
  await expect(pendingOf(second)).resolves.toMatchObject({ interactionId: digest('1') });
  expect(await drain(second, resume(digest('1')))).toEqual([
    { type: 'output', output: 'answered' },
  ]);
});

test('a resumed run writes the next revision and chains it to the one before', async () => {
  const store = new MemoryByteCheckpoints();
  const first = await open(pausing, store);
  await drain(first, start);
  const second = await open(pausing, store);
  await drain(second, resume(digest('1')));
  const rows = [...store.rows.values()].sort((a, b) => a.id.localeCompare(b.id));
  expect(rows.map((row) => row.id)).toEqual(['00000000000000000001', '00000000000000000002']);
  expect(rows.map((row) => row.parentId)).toEqual([null, '00000000000000000001']);
  const keys = rows.map((row) => JSON.parse(new TextDecoder().decode(row.metadata.bytes)).key);
  expect(keys[1]).toBe(keys[0]);
});

test('a storage refusal keeps its reason on the commit and on the load', async () => {
  const refusing = (marker: string, op: string) => ({
    request: async (value: unknown): Promise<unknown> => {
      if ((value as { op: string }).op === op)
        throw Object.assign(new Error('x'), { [marker]: true });
      return (value as { op: string }).op === 'get' ? null : undefined;
    },
  });
  for (const [marker, code] of [
    ['fenced', 'fenced'],
    ['invalidated', 'stale'],
    ['unrecoverable', 'unrecoverable'],
  ] as const) {
    const committing = await open(pausing, refusing(marker, 'put'));
    expect(await drain(committing, start)).toMatchObject([{ type: 'error', error: { code } }]);
    const loading = await open(pausing, refusing(marker, 'get'));
    await expect(pendingOf(loading)).rejects.toMatchObject({ code });
  }
});

test('a save that failed after its marker is retried on the same revision', async () => {
  const store = new MemoryByteCheckpoints();
  let failures = 1;
  const flaky = {
    request: async (value: unknown): Promise<unknown> => {
      if ((value as { op: string }).op === 'put' && failures > 0) {
        failures -= 1;
        throw new Error('quota');
      }
      return store.request(value);
    },
  };
  const setup = await open(pausing, flaky);
  expect(await drain(setup, start)).toMatchObject([
    { type: 'error', error: { code: 'unavailable' } },
  ]);
  expect(store.rows.size).toBe(0);
  expect(await drain(setup, start)).toMatchObject([{ type: 'interaction' }]);
  expect([...store.rows.values()].map((row) => row.id)).toEqual(['00000000000000000001']);
  expect([...store.writes.keys()]).toHaveLength(1);
});

test('a new prompt over a stored pause replaces it and a failing one keeps it', async () => {
  const store = new MemoryByteCheckpoints();
  let starts = 0;
  const program: Program = async (api) => {
    if (api.request.resume !== undefined) return finished();
    starts += 1;
    if (starts === 1) return paused(digest('1'));
    return starts === 2 ? failResult('unavailable') : finished();
  };
  const setup = await open(program, store);
  await drain(setup, start);
  expect(await drain(setup, start)).toMatchObject([{ type: 'error' }]);
  await expect(pendingOf(setup)).resolves.toMatchObject({ interactionId: digest('1') });
  expect(await drain(setup, start)).toEqual([{ type: 'output', output: 'answered' }]);
  await expect(pendingOf(setup)).resolves.toBeUndefined();
  const fresh = await open(program, store);
  await expect(pendingOf(fresh)).resolves.toBeUndefined();
});

async function decodeEdited(
  edit: (parts: {
    id: string;
    body: Record<string, unknown>;
    state: Record<string, unknown>;
  }) => void,
  options: { key?: Uint8Array; position?: number } = {},
): Promise<unknown> {
  const key = options.key ?? new Uint8Array(32).fill(7);
  const body = record(1, digest('1'));
  const state: Record<string, unknown> = {};
  const parts = { id: revisionId(1), body, state };
  edit(parts);
  const { checkpoint, metadata } = await encodeStored(
    's',
    revisionId(1),
    body as never,
    options.position ?? 0,
    key,
  );
  const merged = { ...JSON.parse(new TextDecoder().decode(metadata)), ...state };
  return decodeStored('s', {
    id: parts.id,
    checkpoint: { type: 'adk-go.session/v1', bytes: checkpoint },
    metadata: {
      type: 'galaxie.adk-go-state/v1',
      bytes: new TextEncoder().encode(JSON.stringify(merged)),
    },
  });
}

test.each([
  ['a different revision id', (parts) => (parts.id = revisionId(2))],
  ['a malformed tag', ({ state }) => (state['mac'] = 'zz')],
  ['a key of the wrong length', ({ state }) => (state['key'] = btoa('short'))],
  ['a key that is not base64', ({ state }) => (state['key'] = '***')],
  ['a position edited under the old tag', ({ state }) => (state['position'] = 5)],
  ['a conversation name outside the pattern', ({ body }) => (body['conversation'] = 'x1')],
  ['a pause with no calls', ({ body }) => ((body['pause'] as { calls: unknown[] }).calls = [])],
  ['a pause on ordinal zero', ({ body }) => (body['ordinal'] = 0)],
  ['a pause id that is not a digest', ({ body }) => ((body['pause'] as { id: string }).id = 'abc')],
  ['too many events', ({ body }) => (body['events'] = Array.from({ length: 10_001 }, () => ({})))],
] as Array<
  [
    string,
    (parts: { id: string; body: Record<string, unknown>; state: Record<string, unknown> }) => void,
  ]
>)('a stored record with %s fails unrecoverable', async (_name, edit) => {
  await expect(decodeEdited(edit)).rejects.toMatchObject({ code: 'unrecoverable' });
});

test('a stored record under a valid tag decodes, and a wrong type string does not', async () => {
  await expect(decodeEdited(() => {})).resolves.toMatchObject({ conversation: 'g1', revision: 1 });
  const key = new Uint8Array(32).fill(7);
  const { checkpoint, metadata } = await encodeStored(
    's',
    revisionId(1),
    record(1) as never,
    0,
    key,
  );
  await expect(
    decodeStored('s', {
      id: '00000000000000000001',
      checkpoint: { type: 'other', bytes: checkpoint },
      metadata: { type: 'galaxie.adk-go-state/v1', bytes: metadata },
    }),
  ).rejects.toMatchObject({ code: 'unrecoverable' });
});

test('the tag input separates the session, revision, position and checkpoint bytes', async () => {
  const encoder = new TextEncoder();
  // The old layout let checkpoint bytes shift across the head's final delimiter.
  const oldTagged = (sessionId: string, position: number, checkpoint: string): Uint8Array =>
    encoder.encode(`adk-go|${sessionId}|${position}|${checkpoint}`);
  expect(oldTagged('s|1', 2, 'C')).toEqual(oldTagged('s', 1, '2|C'));

  const firstCheckpoint = encoder.encode('C');
  const secondCheckpoint = encoder.encode('2|C');
  const key = new Uint8Array(32).fill(7);
  const revision = revisionId(1);
  const encoding = vi.spyOn(TextEncoder.prototype, 'encode');
  const signing = vi.spyOn(crypto.subtle, 'sign');
  try {
    // Supply raw checkpoint fixtures while exercising the real tag calculation.
    encoding.mockReturnValueOnce(firstCheckpoint);
    const first = await encodeStored('s|1', revision, record(0), 2, key);
    encoding.mockReturnValueOnce(secondCheckpoint);
    const second = await encodeStored('s', revision, record(0), 1, key);
    const messages = signing.mock.calls.map((call) => call[2]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(
      encoder.encode(`${JSON.stringify(['adk-go', 's|1', revision, 2])}\nC`),
    );
    expect(messages[1]).toEqual(
      encoder.encode(`${JSON.stringify(['adk-go', 's', revision, 1])}\n2|C`),
    );
    expect(messages[0]).not.toEqual(messages[1]);
    const firstState = JSON.parse(new TextDecoder().decode(first.metadata));
    const secondState = JSON.parse(new TextDecoder().decode(second.metadata));
    expect(firstState.mac).not.toBe(secondState.mac);
  } finally {
    encoding.mockRestore();
    signing.mockRestore();
  }
});

test('restored content lists every text-bearing value and nothing else', () => {
  const body = {
    ...record(0, digest('1')),
    counter: 99,
    events: [
      {
        id: 'secret-id',
        author: 'user',
        content: {
          role: 'model',
          parts: [
            { text: 'TEXT' },
            { functionCall: { id: 'c1', name: 'tool', args: { v: 'ARGS' } } },
            { functionResponse: { id: 'c1', name: 'tool', response: { v: 'RESPONSE' } } },
          ],
        },
        actions: {
          stateDelta: { k: 'STATE' },
          requestedToolConfirmations: { c1: { hint: 'CONFIRM' } },
        },
      },
    ],
  };
  const text = JSON.stringify(restoredContent(body as never));
  for (const value of ['TEXT', 'ARGS', 'RESPONSE', 'STATE', 'CONFIRM', 'PRIVATE-CALL'])
    expect(text).toContain(value);
  expect(text).not.toContain('secret-id');
  expect(text).not.toContain('99');
});
