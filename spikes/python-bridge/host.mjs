// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createMockLatch, MockChatModel } from '../../packages/models/src/mock.ts';

export async function exercise(worker, origin, cacheDir) {
  const latch = createMockLatch();
  const model = new MockChatModel({
    langgraph: { id: 'graph', text: '{"content":"mock graph reply"}' },
    'pydantic:first': { id: 'tool', text: '{"tool":{"name":"double","arguments":{"value":21}}}' },
    'pydantic:tool:42': { id: 'final', text: '{"content":"mock agent reply: 42"}' },
    abort: { id: 'abort', text: '{"content":"must not return"}', wait: latch },
  });
  const waits = new Map();
  const events = [];
  const calls = [];
  const controller = new AbortController();
  const busyStarted = Promise.withResolvers();
  let sequence = 0;
  const post = (value) => worker.postMessage(JSON.stringify({ v: 'galaxie.bridge/v1', ...value }));
  const command = (op, fields = {}) => {
    const id = `command-${++sequence}`;
    const deferred = Promise.withResolvers();
    waits.set(id, deferred);
    post({ kind: 'command', id, op, ...fields });
    return deferred.promise;
  };
  const receive = async (raw) => {
    try {
      if (typeof raw !== 'string' || raw.length > 1_000_000) throw Error();
      const message = JSON.parse(raw);
      if (message.kind === 'log') return;
      if (message.kind === 'rejected') {
        events.push(message);
        return;
      }
      if (message.v !== 'galaxie.bridge/v1' || typeof message.id !== 'string') throw Error();
      if (['result', 'failure'].includes(message.kind)) {
        const wait = waits.get(message.id);
        if (!wait) throw Error();
        waits.delete(message.id);
        if (message.kind === 'failure') wait.reject(new Error(message.message));
        else wait.resolve(message.value);
        return;
      }
      if (message.kind === 'busy-started') {
        busyStarted.resolve();
        return;
      }
      if (message.kind === 'aborted') {
        events.push(message);
        return;
      }
      if (message.kind !== 'request' || !['model', 'capability'].includes(message.op))
        throw Error();
      const { payload } = message;
      calls.push({
        op: message.op,
        ...(message.op === 'capability' ? { scope: payload.effectScope } : {}),
      });
      let value;
      if (message.op === 'model') {
        if (
          payload.role !== 'spike' ||
          !Array.isArray(payload.messages) ||
          payload.messages.some((m) => m.role !== 'user' || typeof m.content !== 'string')
        )
          throw Error();
        const reply = await model.invoke(
          payload.messages.map((m) => ['human', m.content]),
          { signal: controller.signal },
        );
        value = JSON.parse(reply.content);
      } else {
        if (
          payload.name !== 'math.double@1' ||
          !Number.isSafeInteger(payload.input?.value) ||
          typeof payload.effectScope !== 'string'
        )
          throw Error();
        value = { value: payload.input.value * 2 };
      }
      post({ kind: 'response', id: message.id, ok: true, value });
    } catch {
      if (controller.signal.aborted) return;
      events.push({ kind: 'host-rejected', code: 'invalid' });
      // Abort rejects outstanding Python promises through an explicit message.
    }
  };
  if (worker.on) worker.on('message', receive);
  else worker.addEventListener('message', (event) => void receive(event.data));
  const started = performance.now();
  const boot = await command('boot', { origin, cacheDir });
  const coldStartMs = performance.now() - started;
  worker.postMessage('{"v":"wrong","kind":"command","id":"malformed","op":"graph"}');
  const graph = await command('graph');
  const resumed = await command('resume', { interactionId: graph.interactionId });
  const agent = await command('agent');
  const abort = command('abortProbe');
  await latch.entered;
  const abortStarted = performance.now();
  controller.abort();
  post({ kind: 'abort', id: 'abort-1' });
  const cancelled = await abort;
  const abortMs = performance.now() - abortStarted;
  if (
    !cancelled.cancelled ||
    events.filter((e) => e.kind === 'rejected').length !== 1 ||
    !events.some((e) => e.kind === 'aborted') ||
    model.calls !== 4
  )
    throw Error('The bridge evidence is incomplete.');
  void command('busy');
  await busyStarted.promise;
  const busyAt = performance.now();
  post({ kind: 'abort', id: 'busy-abort' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const busyAbortAcknowledged = events.some((event) => event.id === 'busy-abort');
  if (busyAbortAcknowledged) throw Error('Synchronous Python unexpectedly yielded.');
  await worker.terminate();
  const forcedTerminationMs = performance.now() - busyAt;
  return {
    boot,
    coldStartMs,
    graph,
    resumed,
    agent,
    abort: cancelled,
    abortMs,
    calls,
    events,
    mockCalls: model.calls,
    busyAbortAcknowledged,
    forcedTerminationMs,
  };
}
