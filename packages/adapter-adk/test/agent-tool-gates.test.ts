// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { GalaxieError, toErrorInfo } from '@galaxie-ai/core';
import {
  AgentTool,
  BaseLlm,
  type Event,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { describe, expect, test, vi } from 'vitest';
import { collect } from '../../core/test/fake-executor.js';
import { createMockLatch } from '../../models/src/mock.js';
import { agentTool } from '../src/index.js';
import { GalaxieSessionService } from '../src/session.js';
import { calls, fixture, type Options, read, spec, text } from './support/agent-tool-fixture.js';

const direct = (host: Parameters<NonNullable<Options['agent']>>[0]) =>
  new LlmAgent({
    name: 'outer',
    model: host.adk.llm('inner'),
    tools: [host.adk.capabilityTool('read@1', spec)],
  });
const toolReply = (messages: readonly { type: string; content: unknown }[]): unknown[] =>
  messages.filter((m) => m.type === 'tool').map((m) => m.content);
const ids = (events: readonly Event[]): string[] =>
  events.flatMap((event) =>
    (event.content?.parts ?? []).flatMap((part) =>
      part.functionCall?.id === undefined ? [] : [part.functionCall.id],
    ),
  );

describe('G2 routing, labels and budgets', () => {
  test('outer and inner calls lease separately and share the step budget', async () => {
    for (const steps of [3, 2]) {
      const f = await fixture({ budgets: { steps } });
      try {
        const events = await f.run();
        expect(events.at(-1)).toMatchObject(
          steps === 3
            ? { type: 'output', output: 'outer done' }
            : { type: 'error', error: { code: 'budget_exceeded' } },
        );
        expect(f.leases).toEqual(steps === 3 ? ['outer', 'inner', 'outer'] : ['outer', 'inner']);
        expect(f.leases).toHaveLength(f.outer.seen.length + f.inner.seen.length);
      } finally {
        await f.runtime.dispose();
      }
    }
  });

  test('inner blocked output fails denied before another outer call', async () => {
    const f = await fixture({ inner: () => text('BLOCKED_TEXT'), block: 'BLOCKED_TEXT' });
    try {
      expect((await f.run()).at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
      expect(f.outer.seen).toHaveLength(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  test.each([true, false])(
    'inner private labels match outer-direct policy allowed=%s',
    async (allowed) => {
      const outcomes: unknown[] = [];
      for (const wrapped of [false, true]) {
        const f = await fixture({
          privateOutput: true,
          dataPolicy: { 'private-user': { allow: allowed ? ['in-browser'] : [] } },
          inner: (_seen, index) => (index === 0 ? read() : text('inner done')),
          ...(wrapped ? {} : { agent: direct }),
        });
        try {
          const event = (await f.run()).at(-1);
          outcomes.push(event?.type === 'error' ? event.error.code : event?.type);
          expect(f.invocations()).toBe(1);
          expect(f.inner.seen).toHaveLength(allowed ? 2 : 1);
          if (wrapped && !allowed) expect(f.outer.seen).toHaveLength(1);
        } finally {
          await f.runtime.dispose();
        }
      }
      expect(outcomes).toEqual(allowed ? ['output', 'output'] : ['denied', 'denied']);
    },
  );

  test.each([true, false])('inner capability honors run grants granted=%s', async (granted) => {
    const f = await fixture({
      grantScope: 'run',
      grants: granted ? ['read@1'] : [],
      inner: (_seen, index) => (index === 0 ? read() : text('inner done')),
    });
    try {
      expect((await f.run()).at(-1)).toMatchObject({ type: 'output' });
      expect(f.invocations()).toBe(granted ? 1 : 0);
      if (!granted)
        expect(
          toolReply(f.inner.seen[1]?.messages ?? []).map((value) => JSON.parse(String(value))),
        ).toEqual([{ error: toErrorInfo('denied').message }]);
    } finally {
      await f.runtime.dispose();
    }
  });

  test('inner capability budget is the same broker budget as a direct call', async () => {
    for (const wrapped of [false, true]) {
      const f = await fixture({
        budgets: { toolCalls: 1 },
        inner: () => read(),
        ...(wrapped ? {} : { agent: direct }),
      });
      try {
        expect((await f.run()).at(-1)).toMatchObject({
          type: 'error',
          error: { code: 'budget_exceeded' },
        });
        expect(f.invocations()).toBe(1);
      } finally {
        await f.runtime.dispose();
      }
    }
  });
});

describe('G3 isolation and call identity', () => {
  test('simultaneous calls have independent sessions and keys and stay out of outer history and streams', async () => {
    const created: GalaxieSessionService[] = [];
    const keys: Uint8Array[] = [];
    const create = GalaxieSessionService.prototype.createSession;
    const random = crypto.getRandomValues.bind(crypto);
    const sessionSpy = vi
      .spyOn(GalaxieSessionService.prototype, 'createSession')
      .mockImplementation(function (this: GalaxieSessionService, request) {
        created.push(this);
        return create.call(this, request);
      });
    const keySpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      const result = random(array);
      if (array instanceof Uint8Array && array.length === 32) keys.push(array.slice());
      return result;
    });
    const f = await fixture({
      outer: (_seen, index) => (index === 0 ? calls('one', 'two') : text('outer done')),
      inner: (seen) => text(String(seen.messages.at(-1)?.content)),
    });
    try {
      const events = await f.run();
      expect(events.at(-1)).toMatchObject({ type: 'output', output: 'outer done' });
      expect(new Set(created).size).toBe(3);
      expect(keys).toHaveLength(3);
      expect(keys[1]).not.toEqual(keys[2]);
      expect(f.inner.seen).toHaveLength(2);
      expect(
        f.inner.seen.map((seen) =>
          seen.messages
            .filter((message) => message.type === 'human')
            .map((message) => message.content),
        ),
      ).toEqual([['one'], ['two']]);
      expect(
        toolReply(f.outer.seen[1]?.messages ?? []).map((value) => JSON.parse(String(value))),
      ).toEqual([{ result: 'one' }, { result: 'two' }]);
      expect(f.record()?.events.some((event) => event.author === 'inner')).toBe(false);
      expect(
        events
          .filter((event) => event.type === 'stream' && event.mode === 'messages')
          .map((event) => (event.type === 'stream' ? event.data : undefined)),
      ).toEqual([{ author: 'outer', text: 'outer done' }]);
      const storedIds = ids(f.record()?.events ?? []);
      expect(new Set(storedIds).size).toBe(2);
    } finally {
      await f.runtime.dispose();
      sessionSpy.mockRestore();
      keySpy.mockRestore();
    }
  });

  test('gapped stored IDs continue above the maximum on reload and after failure/retry', async () => {
    const first = await fixture({
      outer: (_seen, index) =>
        index < 2 ? calls(index === 0 ? 'first' : 'second') : text('outer done'),
      inner: (seen) =>
        seen.messages.some((message) => message.type === 'tool') ? text('inner done') : read(),
    });
    expect((await first.run()).at(-1)).toMatchObject({ type: 'output' });
    expect(ids(first.record()?.events ?? [])).toEqual(['galaxie-0', 'galaxie-2']);
    const sessionId = first.instance.sessionId;
    const before = first.record()?.events;
    await first.runtime.dispose();
    let fail = true;
    const next = await fixture({
      store: first.store,
      sessionId,
      outer: (_seen, index) => {
        if (index % 2 === 0) return calls('next');
        if (fail) throw new Error('outer failure');
        return text('continued');
      },
    });
    try {
      expect((await next.run()).at(-1)).toMatchObject({
        type: 'error',
        error: { code: 'unavailable' },
      });
      expect(next.record()?.events).toEqual(before);
      fail = false;
      expect((await next.run()).at(-1)).toMatchObject({ type: 'output', output: 'continued' });
      expect(ids(next.record()?.events ?? [])).toEqual(['galaxie-0', 'galaxie-2', 'galaxie-3']);
      expect(toolReply(next.outer.seen[0]?.messages ?? [])).toHaveLength(2);
    } finally {
      await next.runtime.dispose();
    }
  });
});

class NativeModel extends BaseLlm {
  readonly #inner: boolean;
  #calls = 0;
  constructor(inner: boolean) {
    super({ model: 'scripted' });
    this.#inner = inner;
  }
  override async *generateContentAsync(_request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: this.#inner
          ? [{ text: 'inner done' }]
          : this.#calls++ === 0
            ? [{ functionCall: { name: 'inner', args: { request: 'request' } } }]
            : [{ text: 'outer done' }],
      },
      turnComplete: true,
    };
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}

describe('G4 native result and state parity', () => {
  test('copies outer state and forwards ordinary deltas without temporary state', async () => {
    const copied: unknown[] = [];
    const observed: unknown[] = [];
    const build = (
      innerModel: BaseLlm,
      outerModel: BaseLlm,
      wrap: (inner: LlmAgent) => AgentTool,
    ): LlmAgent => {
      const inner = new LlmAgent({
        name: 'inner',
        model: innerModel,
        beforeAgentCallback: (context) => {
          copied.push([context.state.get('k'), context.state.get('temp:x')]);
          context.state.update({ changed: 'yes', 'temp:hidden': 'inner only' });
          return undefined;
        },
      });
      return new LlmAgent({
        name: 'outer',
        model: outerModel,
        tools: [wrap(inner)],
        beforeAgentCallback: (context) => {
          context.state.update({ k: 'v', 'temp:x': 1 });
          return undefined;
        },
        afterAgentCallback: (context) => {
          observed.push([context.state.get('changed'), context.state.get('temp:hidden')]);
          return undefined;
        },
      });
    };
    const native = new InMemoryRunner({
      appName: 'native',
      agent: build(
        new NativeModel(true),
        new NativeModel(false),
        (inner) => new AgentTool({ agent: inner }),
      ),
    });
    await native.sessionService.createSession({
      appName: 'native',
      userId: 'user',
      sessionId: 'conversation',
    });
    const events = await collect(
      native.runAsync({
        userId: 'user',
        sessionId: 'conversation',
        newMessage: { role: 'user', parts: [{ text: 'delegate' }] },
      }),
    );
    expect(events.at(-1)?.content?.parts).toEqual([{ text: 'outer done' }]);
    const f = await fixture({
      agent: (host) =>
        build(host.adk.llm('inner'), host.adk.llm('outer'), (inner) => agentTool(host, inner)),
    });
    try {
      expect((await f.run()).at(-1)).toMatchObject({ type: 'output', output: 'outer done' });
      expect(copied[0]).toEqual(['v', undefined]);
      expect(copied[1]).toEqual(copied[0]);
      expect(observed).toEqual([
        ['yes', undefined],
        ['yes', undefined],
      ]);
      expect(
        toolReply(f.outer.seen[1]?.messages ?? []).map((value) => JSON.parse(String(value))),
      ).toEqual([{ result: 'inner done' }]);
      expect(JSON.stringify(f.record())).not.toContain('inner only');
    } finally {
      await f.runtime.dispose();
    }
  });
});

describe('G5 inner failure propagation', () => {
  test.each(['provider', 'output', 'budget', 'capability', 'event'] as const)(
    '%s matches an outer-direct control without a later outer tool response',
    async (kind) => {
      const outcomes: unknown[] = [];
      for (const wrapped of [false, true]) {
        const f = await fixture({
          inner: () => {
            if (kind === 'provider') throw new Error('provider text');
            return kind === 'capability' || kind === 'budget'
              ? read()
              : text(kind === 'output' ? 'BLOCKED_TEXT' : 'unused');
          },
          ...(kind === 'output' ? { block: 'BLOCKED_TEXT' } : {}),
          ...(kind === 'budget' ? { budgets: { toolCalls: 1 } } : {}),
          ...(kind === 'capability'
            ? {
                invoke: async () => {
                  throw new Error('binding text');
                },
              }
            : {}),
          agent: (host) => {
            const inner = new LlmAgent({
              name: 'inner',
              model: host.adk.llm('inner'),
              tools: [host.adk.capabilityTool('read@1', spec)],
              ...(kind === 'event'
                ? {
                    beforeModelCallback: () => ({
                      errorCode: 'CALLBACK',
                      errorMessage: 'private event text',
                    }),
                  }
                : {}),
            });
            return wrapped
              ? new LlmAgent({
                  name: 'outer',
                  model: host.adk.llm('outer'),
                  tools: [agentTool(host, inner)],
                })
              : inner;
          },
        });
        try {
          const events = await f.run();
          const last = events.at(-1);
          outcomes.push(last?.type === 'error' ? last.error.code : last?.type);
          if (wrapped) expect(f.outer.seen).toHaveLength(1);
          expect(JSON.stringify(events)).not.toMatch(
            /provider text|binding text|private event text/,
          );
        } finally {
          await f.runtime.dispose();
        }
      }
      expect(outcomes).toEqual(
        kind === 'output'
          ? ['denied', 'denied']
          : kind === 'budget'
            ? ['budget_exceeded', 'budget_exceeded']
            : ['unavailable', 'unavailable'],
      );
    },
  );

  test.each(['denied', 'invalid'] as const)(
    'capability %s stays visible to the inner model',
    async (code) => {
      const f = await fixture({
        inner: (_seen, index) => (index === 0 ? read() : text('inner done')),
        invoke: async () => {
          throw new GalaxieError(code, 'private error');
        },
      });
      try {
        expect((await f.run()).at(-1)).toMatchObject({ type: 'output', output: 'outer done' });
        expect(
          toolReply(f.inner.seen[1]?.messages ?? []).map((value) => JSON.parse(String(value))),
        ).toEqual([
          {
            error: toErrorInfo(code).message,
          },
        ]);
      } finally {
        await f.runtime.dispose();
      }
    },
  );

  test('outer cancellation aborts a waiting inner call like the direct control', async () => {
    const outcomes: string[] = [];
    for (const wrapped of [false, true]) {
      const latch = createMockLatch();
      let aborted = false;
      const f = await fixture({
        inner: async (seen) => {
          const signal = seen.options['signal'] as AbortSignal;
          try {
            await latch.wait(signal);
          } finally {
            aborted = signal.aborted;
          }
          return text('late');
        },
        ...(wrapped ? {} : { agent: direct }),
      });
      try {
        const run = await f.instance.start({ prompt: 'public' });
        const pending = collect(f.instance.events(run.runId));
        await latch.entered;
        await f.instance.cancel(run.runId);
        await pending;
        expect(aborted).toBe(true);
        outcomes.push(f.instance.getSnapshot().run?.status ?? 'missing');
        if (wrapped) expect(f.outer.seen).toHaveLength(1);
      } finally {
        latch.release();
        await f.runtime.dispose();
      }
    }
    expect(outcomes).toEqual(['cancelled', 'cancelled']);
  });
});

describe('G7 outer durability', () => {
  test('reload preserves wrapper history and a failed turn leaves bytes and revision unchanged', async () => {
    const first = await fixture();
    expect((await first.run()).at(-1)).toMatchObject({ type: 'output' });
    const sessionId = first.instance.sessionId;
    const before = first.record()?.events;
    const bytes = structuredClone([...first.store.rows]);
    await first.runtime.dispose();
    let fail = true;
    const next = await fixture({
      store: first.store,
      sessionId,
      outer: (_seen, index) => {
        if (index % 2 === 0) return calls('again');
        if (fail) throw new Error('outer failure');
        return text('continued');
      },
    });
    try {
      expect((await next.run('failed turn')).at(-1)).toMatchObject({
        type: 'error',
        error: { code: 'unavailable' },
      });
      expect([...next.store.rows]).toEqual(bytes);
      expect(next.record()?.events).toEqual(before);
      fail = false;
      expect((await next.run('retry')).at(-1)).toMatchObject({
        type: 'output',
        output: 'continued',
      });
      const firstHistory = next.outer.seen[0]?.messages.slice(0, -1);
      expect(next.outer.seen[2]?.messages.slice(0, -1)).toEqual(firstHistory);
      expect(toolReply(next.outer.seen[0]?.messages ?? [])).toHaveLength(1);
      expect(next.record()?.events.some((event) => event.author === 'inner')).toBe(false);
    } finally {
      await next.runtime.dispose();
    }
  });
});
