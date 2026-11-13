// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import type { ExecutorEvent, SessionId } from '@galaxie-ai/core';
import { LlmAgent as Agent } from '@google/adk';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { binding, brokerFixture, collect } from '../../core/test/fake-executor.js';
import { type AdkAgent, agentTool, createAdkAdapter, defineAdkEntry } from '../src/index.js';
import { calls, fixture, read, spec, text } from './support/agent-tool-fixture.js';
import { FakeChatModel, fakeModels } from './support/fixtures.js';

describe('G6 entry-only admission sub-rule', () => {
  test.each([
    ['write', 'confirm', true],
    ['write', 'confirm', false],
    ['write', 'none', false],
    ['read', 'confirm', true],
    ['missing', 'none', false],
  ] as const)(
    'refuses %s/%s with confirmations=%s before inner work and rolls back',
    async (kind, approval, confirmations) => {
      const f = await fixture({ kind, approval, confirmations, outer: () => calls('request') });
      try {
        expect((await f.run('first attempt')).at(-1)).toMatchObject({
          type: 'error',
          error: { code: 'unsupported' },
        });
        expect(f.outer.seen).toHaveLength(1);
        expect(f.inner.seen).toEqual([]);
        expect(f.leases).toEqual(['outer']);
        expect(f.invocations()).toBe(0);
        expect(f.store.rows.size).toBe(0);
        expect(f.operations).toHaveLength(1);
        expect(f.operations[0]).toMatchObject({ op: 'get' });
        expect((await f.run('retry')).at(-1)).toMatchObject({
          type: 'error',
          error: { code: 'unsupported' },
        });
        expect(
          f.outer.seen[1]?.messages
            .filter((message) => message.type === 'human')
            .map((message) => message.content),
        ).toEqual(['retry']);
        expect(f.outer.seen[1]?.messages.some((message) => message.type === 'tool')).toBe(false);
        expect(f.store.rows.size).toBe(0);
      } finally {
        await f.runtime.dispose();
      }
    },
  );
  test('admits read-only tools', async () => {
    const f = await fixture({
      inner: (_seen, index) => (index === 0 ? read() : text('inner done')),
    });
    try {
      expect((await f.run()).at(-1)).toMatchObject({ type: 'output' });
      expect(f.invocations()).toBe(1);
    } finally {
      await f.runtime.dispose();
    }
  });
});

test('G6 a stored-pause resume refuses non-read inner policy at wrapper entry after one outer lease', async () => {
  const bytes = new MemoryByteCheckpoints();
  const store = { request: vi.fn((value: unknown) => bytes.request(value)) };
  let resumed = false;
  const model = new FakeChatModel(() => (resumed ? calls('request') : read()));
  const factory: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new Agent({
        name: 'outer',
        model: host.adk.llm('agent'),
        tools: [
          host.adk.capabilityTool('read@1', { ...spec, requireConfirmation: true }),
          agentTool(
            host,
            new Agent({
              name: 'inner',
              model: host.adk.llm('agent'),
              tools: [host.adk.capabilityTool('read@1', spec)],
            }),
          ),
        ],
      }),
      interaction: () => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'tests.Approval/v1',
        props: {},
      }),
    });
  const prepare = () =>
    createAdkAdapter().prepare(
      factory,
      { chatModels: { mock: model }, checkpoints: store },
      {
        signal: new AbortController().signal,
        models: { roles: ['agent'], providers: { mock: { credential: false } } },
      },
    );
  const first = await prepare();
  let sessionId: SessionId;
  let paused: Extract<ExecutorEvent, { type: 'interaction' }>;
  const before = await brokerFixture({
    requests: { 'read@1': { kind: 'read', input: z.object({}), output: z.unknown() } },
    bindings: { 'read@1': binding() },
    scripts: [
      async function* (request) {
        sessionId = request.sessionId;
        const events = await collect(
          first.run({
            ...request,
            command: { type: 'start', input: { prompt: 'pause' } },
            models: fakeModels().port,
          }),
        );
        const event = events.find((event) => event.type === 'interaction');
        expect(event?.type).toBe('interaction');
        if (event?.type !== 'interaction') throw new Error('Expected stored pause.');
        paused = event;
        yield { type: 'output', output: null };
      },
    ],
  });
  try {
    const run = await before.instance.start('public');
    await collect(before.instance.events(run.runId));
    expect(before.scriptErrors).toEqual([]);
  } finally {
    await before.runtime.dispose();
    await first.dispose();
  }
  resumed = true;
  const storedRows = structuredClone([...bytes.rows]);
  const second = await prepare();
  store.request.mockClear();
  model.seen.splice(0);
  const models = fakeModels();
  const after = await brokerFixture({
    requests: { 'read@1': { kind: 'write', input: z.object({}), output: z.unknown() } },
    bindings: { 'read@1': binding({ kind: 'write', approval: 'confirm' }) },
    scripts: [
      async function* (request) {
        const events = await collect(
          second.run({
            ...request,
            sessionId,
            models: models.port,
            registerRestoredData: () => {},
            command: {
              type: 'resume',
              interactionId: paused.interaction.interactionId,
              action: 'approve',
              payload: { indexes: [0] },
            },
          }),
        );
        expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
        expect(store.request).toHaveBeenCalledTimes(1);
        expect([...bytes.rows]).toEqual(storedRows);
        expect(models.leases.map((lease) => lease.role)).toEqual(['agent']);
        expect(model.seen).toHaveLength(1);
        yield { type: 'output', output: null };
      },
    ],
  });
  try {
    const run = await after.instance.start('public');
    await collect(after.instance.events(run.runId));
    expect(after.scriptErrors).toEqual([]);
  } finally {
    await after.runtime.dispose();
    await second.dispose();
  }
});
