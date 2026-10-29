// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import {
  acquireOwnership,
  type CapabilityBinding,
  type CapabilityRequests,
  type ConfirmationOptions,
  createRuntime,
  type DiagnosticEvent,
  type Ownership,
  type RecoveryStore,
  type SessionId,
  watchInvalidation,
} from '@galaxie/core';
import { defineConfirmations } from '@galaxie/react';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { binding, collect } from '../../packages/core/test/fake-executor.js';
import {
  assertSpanTree,
  createSpanRecorder,
  serializeSpans,
} from '../../packages/core/test/span-tree.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';

const hostText = 'host-confirmation-title-marker';
const argument = 'private-confirmation-argument-marker';
const registry = defineConfirmations({
  'write@1': {
    title: hostText,
    fields: (args) => [
      { label: 'Destination', value: (args as { destination: string }).destination },
    ],
    approveLabel: 'Host allow',
  },
});

async function fixture(
  options: {
    readonly args?: { destination: string };
    readonly confirmations?: Partial<ConfirmationOptions>;
    readonly lookAlike?: boolean;
    readonly twice?: boolean;
    readonly recovery?: RecoveryStore;
    readonly checkpointer?: MemorySaver;
    readonly sessionId?: SessionId;
  } = {},
) {
  const args = options.args ?? { destination: argument };
  const diagnostics: DiagnosticEvent[] = [];
  const callErrors: unknown[] = [];
  const invoke = vi.fn<CapabilityBinding['invoke']>(async () => 'tool-result-marker');
  const recorder = createSpanRecorder();
  const runtime = createRuntime({
    appId: 'confirmations-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: recorder.provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  onTestFinished(async () => {
    await runtime.dispose();
    await recorder.provider.shutdown();
  });
  const requests: CapabilityRequests = {
    'write@1': { input: z.unknown(), output: z.unknown(), kind: 'write' },
  };
  const instance = await runtime.create(
    {
      id: 'conformance/confirmations',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      capabilities: { required: requests },
    },
    {
      principalScope: 'learner',
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      confirmations: {
        capabilities: registry.capabilities,
        policyRevision: () => 'v1',
        ...options.confirmations,
      },
      bindings: { 'write@1': binding({ kind: 'write', approval: 'confirm', invoke }) },
      services: { chatModels: {}, checkpointer: options.checkpointer ?? new MemorySaver() },
      agent: (host) =>
        new StateGraph(Annotation.Root({ done: Annotation<boolean> }))
          .addNode('write', async (_state, config) => {
            if (options.lookAlike)
              await requestInteraction(
                {
                  component: 'tests.LookAlike/v1',
                  surfaceId: 'agent',
                  viewRevision: 'v1' as never,
                  props: { title: 'Allow', action: 'approve' },
                },
                config,
              );
            try {
              await host.capabilities.call('write@1', args, config);
              if (options.twice) await host.capabilities.call('write@1', args, config);
            } catch (error) {
              callErrors.push(error);
              throw error;
            }
            return { done: true };
          })
          .addEdge(START, 'write')
          .addEdge('write', END)
          .compile({ checkpointer: host.langchain.checkpointer() }),
    },
  );
  await instance.prepare();
  const run = options.sessionId === undefined ? await instance.start({}) : await instance.restore();
  if (run === undefined) throw new Error('Missing restored run.');
  const events = collect(instance.events(run.runId));
  return { runtime, instance, invoke, diagnostics, recorder, events, callErrors };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function opened(f: Fixture) {
  await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
  const entry = f.instance.getSnapshot().confirmations?.[0];
  if (entry === undefined) throw new Error('Missing confirmation.');
  return entry;
}

async function noLeaks(f: Fixture, id: string): Promise<void> {
  const events = await f.events;
  await f.runtime.dispose();
  await f.recorder.provider.forceFlush();
  const spans = f.recorder.exporter.getFinishedSpans();
  for (const traceId of new Set(spans.map((span) => span.spanContext().traceId)))
    assertSpanTree(spans.filter((span) => span.spanContext().traceId === traceId));
  const text =
    JSON.stringify({
      diagnostics: f.diagnostics,
      events,
      errors: f.callErrors.map((error) => String(error)),
    }) + serializeSpans(spans);
  for (const value of [id, argument, hostText, 'tool-result-marker'])
    expect(text).not.toContain(value);
  for (const error of f.callErrors) expect(error).not.toHaveProperty('cause');
}

test('AT-28 registry text uses real frozen parameters, and approved results stay out of telemetry', async () => {
  const f = await fixture();
  const entry = await opened(f);
  const host = registry.entry(entry.capability);
  expect(host?.title).toBe(hostText);
  expect(host?.fields(entry.arguments)).toEqual([{ label: 'Destination', value: argument }]);
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.instance.respond(entry.id, 'approve')).toEqual({ status: 'approved' });
  await f.events;
  expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(f.invoke).toHaveBeenCalledExactlyOnceWith(
    entry.arguments,
    expect.objectContaining({ principalScope: 'learner', effectId: expect.any(String) }),
  );
  await noLeaks(f, entry.id);
});

test('AT-28 an agent interaction named approve cannot approve the capability', async () => {
  const f = await fixture({ lookAlike: true });
  await vi.waitFor(() => expect(f.instance.getSnapshot().run?.pending).toBeDefined());
  const run = f.instance.getSnapshot().run;
  const pending = run?.pending;
  if (run === undefined || pending === undefined) throw new Error('Missing interaction.');
  expect(
    await f.instance.dispatch({
      instanceId: f.instance.instanceId,
      runId: run.runId,
      ...pending,
      action: 'approve',
      payload: {},
    }),
  ).toMatchObject({ status: 'accepted' });
  const confirmation = await opened(f);
  expect(f.invoke).not.toHaveBeenCalled();
  f.instance.respond(confirmation.id, 'approve');
  await f.events;
  expect(f.invoke).toHaveBeenCalledTimes(1);
  await noLeaks(f, confirmation.id);
});

test('AT-28 approved IDs cannot be replayed, including for identical calls', async () => {
  const f = await fixture({ twice: true });
  const first = await opened(f);
  f.instance.respond(first.id, 'approve');
  await vi.waitFor(() =>
    expect(f.instance.getSnapshot().confirmations?.[0]?.id).not.toBe(first.id),
  );
  const second = await opened(f);
  expect(f.instance.respond(first.id, 'approve')).toEqual({ status: 'stale' });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  f.instance.respond(second.id, 'approve');
  await f.events;
  expect(f.invoke).toHaveBeenCalledTimes(2);
  await noLeaks(f, first.id);
});

test('AT-28 changed original arguments never replace the approved frozen value', async () => {
  const args = { destination: argument };
  const f = await fixture({ args });
  const entry = await opened(f);
  f.instance.respond(entry.id, 'approve');
  args.destination = 'changed-argument-marker';
  expect(Reflect.set(entry.arguments as object, 'destination', 'changed-argument-marker')).toBe(
    false,
  );
  await f.events;
  expect(f.invoke.mock.calls[0]?.[0]).toEqual({ destination: argument });
  expect(Object.isFrozen(f.invoke.mock.calls[0]?.[0])).toBe(true);
  await noLeaks(f, entry.id);
});

test('AT-28 expired approvals are stale even when the expiry timer has not run', async () => {
  const f = await fixture({ confirmations: { expiresInMs: 1000 } });
  const entry = await opened(f);
  const now = vi.spyOn(Date, 'now').mockReturnValue(entry.expiresAt);
  try {
    expect(f.instance.respond(entry.id, 'approve')).toEqual({ status: 'stale' });
  } finally {
    now.mockRestore();
  }
  await f.events;
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.callErrors[0]).toMatchObject({ code: 'denied' });
  expect(f.diagnostics.filter((event) => event.kind === 'confirmation_expired')).toHaveLength(1);
  await noLeaks(f, entry.id);
});

test('AT-28 logout through a real invalidation announcement closes approvals', async () => {
  const appId = `confirmations-${crypto.randomUUID()}`;
  const watcher = watchInvalidation({ appId, principalScope: 'learner' });
  const peer = watchInvalidation({ appId, principalScope: 'learner' });
  onTestFinished(() => {
    watcher.close();
    peer.close();
  });
  const f = await fixture({ confirmations: { signals: [watcher.signal] } });
  const entry = await opened(f);
  peer.announce();
  await f.events;
  expect(watcher.signal.aborted).toBe(true);
  expect(f.instance.getSnapshot().confirmations).toBeUndefined();
  expect(f.instance.respond(entry.id, 'approve')).toEqual({ status: 'stale' });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.callErrors[0]).toMatchObject({ code: 'denied' });
  await noLeaks(f, entry.id);
});

test('AT-28 takeover through a real ownership signal invalidates approvals', async () => {
  const appId = `confirmations-${crypto.randomUUID()}`;
  const owners: Ownership[] = [];
  onTestFinished(async () => {
    for (const owner of owners) await owner.release();
  });
  const first = await acquireOwnership({ appId, onHandoverRequest: () => {} });
  if (first.status !== 'owner') throw new Error('Missing initial owner.');
  owners.push(first.ownership);
  const f = await fixture({ confirmations: { signals: [first.ownership.signal] } });
  const entry = await opened(f);
  const second = await acquireOwnership({ appId, takeover: true, onHandoverRequest: () => {} });
  if (second.status !== 'owner') throw new Error('Missing new owner.');
  owners.push(second.ownership);
  await f.events;
  expect(first.ownership.signal.aborted).toBe(true);
  expect(f.instance.respond(entry.id, 'approve')).toEqual({ status: 'stale' });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.callErrors[0]).toMatchObject({ code: 'denied' });
  await noLeaks(f, entry.id);
});

test('approvals are not recovered: a restored accepted write asks again', async () => {
  const recovery = new MemoryRecoveryStore();
  const checkpointer = new MemorySaver();
  const first = await fixture({ recovery, checkpointer, lookAlike: true });
  await vi.waitFor(() => expect(first.instance.getSnapshot().run?.pending).toBeDefined());
  const run = first.instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('Missing interaction.');
  await first.instance.dispatch({
    instanceId: first.instance.instanceId,
    runId: run.runId,
    ...run.pending,
    action: 'approve',
    payload: {},
  });
  const before = await opened(first);
  await first.runtime.dispose();
  const restored = await fixture({
    recovery,
    checkpointer,
    lookAlike: true,
    sessionId: first.instance.sessionId,
  });
  const after = await opened(restored);
  expect(after.id).not.toBe(before.id);
  expect(restored.instance.respond(before.id, 'approve')).toEqual({ status: 'stale' });
  expect(restored.invoke).not.toHaveBeenCalled();
  restored.instance.respond(after.id, 'approve');
  await restored.events;
  expect(restored.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(restored.invoke).toHaveBeenCalledTimes(1);
  expect(first.invoke).not.toHaveBeenCalled();
});
