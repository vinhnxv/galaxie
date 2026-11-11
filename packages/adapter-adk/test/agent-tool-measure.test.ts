// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { capabilityBindingPolicy } from '@galaxie-ai/core';
import { type Event, LlmAgent, Runner, StreamingMode, ToolCallIntegrityPlugin } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, brokerFixture, collect } from '../../core/test/fake-executor.js';
import { createHost } from '../src/host.js';
import { GalaxieSessionService } from '../src/session.js';
import { validateAgentTree } from '../src/validate.js';
import {
  type PrototypeRegistry,
  prototypeTool,
  validatePrototype,
} from './support/agent-tool-prototype.js';
import { FakeChatModel, fakeModels, fakeRun } from './support/fixtures.js';

/*
Outcome: REFUSED under the rule committed before measurement.
Gate | Observed on Node and Chromium | Result
G1 | Native tests: declaration, subclass, text, state, swallowed error/pause, abort | PASS
G2 | Three router leases; shared inner step limit and output block; labels unmeasured | UNMEASURED as a whole
G3 | Inner session/event separation; reload/retry IDs and fresh-key comparison unmeasured | UNMEASURED as a whole
G4 | Inner text result matches native; prototype state forwarding unmeasured | UNMEASURED as a whole
G5 | Inner budget and output errors stop before outer tool response; other failures unmeasured | UNMEASURED as a whole
G6 | Proposed flag-based pause registry accepts an unflagged host write tool at prepare | FAIL
G7 | Not measured after decisive base-shape refusal | UNMEASURED
The predicted overall support and prepare-time write refusal did not hold.
The host's binding policy is available on the run port, not during prepare.
No assertion claims an unconfirmed write executes: the real broker still refuses
confirmation-required calls without a host confirmation surface.
*/

function setup(steps = 8, block?: string) {
  const model = new FakeChatModel((seen) => {
    const inner = seen.messages.some((message) => message.type === 'human' && message.text === 'r');
    if (inner) return new AIMessage({ content: block ?? 'inner done' });
    return seen.messages.some((message) => message.type === 'tool')
      ? new AIMessage({ content: 'outer done' })
      : new AIMessage({
          content: '',
          tool_calls: [{ name: 'worker', args: { request: 'r' }, id: 'provider' }],
        });
  });
  const { port, leases } = fakeModels(block === undefined ? {} : { block });
  const { run } = fakeRun(port, { steps });
  const { host, registry: trusted } = createHost(
    { chatModels: { mock: model } },
    { roles: ['agent'], providers: { mock: { credential: false } } },
    () => run,
    () => 'conversation',
  );
  const registry: PrototypeRegistry = { trusted, wrappers: new WeakMap(), pausing: new WeakSet() };
  const inner = new LlmAgent({ name: 'worker', model: host.adk.llm('agent') });
  const observations = { keys: [] as Uint8Array[], sessions: [] as GalaxieSessionService[] };
  const wrapper = prototypeTool(inner, registry, () => run, observations);
  const outer = new LlmAgent({ name: 'outer', model: host.adk.llm('agent'), tools: [wrapper] });
  return { host, registry, inner, outer, model, leases, run, observations };
}

async function drive(fixture: ReturnType<typeof setup>): Promise<Event[]> {
  const sessions = new GalaxieSessionService();
  await sessions.createSession({ appName: 'galaxie', userId: 'galaxie', sessionId: 'outer' });
  const runner = new Runner({
    appName: 'galaxie',
    agent: fixture.outer,
    sessionService: sessions,
    plugins: [
      new ToolCallIntegrityPlugin({ secretKey: crypto.getRandomValues(new Uint8Array(32)) }),
    ],
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'galaxie',
    sessionId: 'outer',
    abortSignal: fixture.run.signal,
    newMessage: { role: 'user', parts: [{ text: 'delegate' }] },
    runConfig: { streamingMode: StreamingMode.NONE, maxLlmCalls: 20 },
  }))
    events.push(event);
  return events;
}

test('prototype routes all three calls and isolates inner events', async () => {
  const fixture = setup(3);
  validatePrototype(fixture.inner, fixture.registry);
  validateAgentTree(fixture.outer, fixture.registry.trusted);
  const events = await drive(fixture);
  expect(fixture.run.failure).toBeUndefined();
  expect(fixture.leases).toHaveLength(3);
  expect(fixture.leases[0]?.checked[0]).toContain('{"request":"r"}');
  expect(fixture.leases.slice(1).map((lease) => lease.checked)).toEqual([
    ['inner done'],
    ['outer done'],
  ]);
  expect(fixture.model.seen[2]?.messages.find((message) => message.type === 'tool')?.text).toBe(
    '{"result":"inner done"}',
  );
  expect(events.some((event) => event.author === 'worker')).toBe(false);
  expect(fixture.observations.sessions).toHaveLength(1);
});

test.each([
  ['budget', 'budget_exceeded'],
  ['output', 'denied'],
] as const)(
  'prototype inner %s failure never becomes an outer tool response',
  async (kind, code) => {
    const fixture = setup(
      kind === 'budget' ? 1 : 3,
      kind === 'output' ? 'BLOCKED_TEXT' : undefined,
    );
    await drive(fixture);
    expect(fixture.run.failure?.code).toBe(code);
    expect(fixture.model.seen).toHaveLength(kind === 'budget' ? 1 : 2);
    expect(
      fixture.model.seen
        .flatMap((seen) => seen.messages)
        .some((message) => message.type === 'tool'),
    ).toBe(false);
  },
);

test('proposed pause registry accepts a write tool without its optional ADK confirmation flag', async () => {
  const fixture = setup();
  const write = fixture.host.adk.capabilityTool('save@1', {
    description: 'Save.',
    parameters: z.object({ value: z.string() }),
  });
  fixture.inner.tools.push(write);
  // Faithful proposed registration: only requireConfirmation/longRunning/requestInput enter pausing.
  expect(await write.checkRequireConfirmation({ value: 'x' })).toBe(false);
  expect(write.isLongRunning).toBe(false);
  expect(fixture.registry.pausing.has(write)).toBe(false);
  expect(() => validatePrototype(fixture.inner, fixture.registry)).not.toThrow();
  fixture.registry.pausing.add(write);
  expect(() => validatePrototype(fixture.inner, fixture.registry)).toThrowError(
    expect.objectContaining({ code: 'unsupported' }),
  );
  fixture.registry.pausing.delete(write);
  expect(fixture.model.seen).toHaveLength(0);

  // Binding classification is authoritative and exists on the run port, not at prepare.
  const broker = await brokerFixture({
    requests: {
      'save@1': { kind: 'write', input: z.object({ value: z.string() }), output: z.string() },
    },
    bindings: { 'save@1': binding({ kind: 'write', approval: 'confirm' }) },
    scripts: [
      async function* ({ capabilities }) {
        expect(capabilityBindingPolicy(capabilities, 'save@1')).toEqual({
          kind: 'write',
          approval: 'confirm',
          confirmationAvailable: false,
        });
        await expect(capabilities.call('save@1', { value: 'x' })).rejects.toMatchObject({
          code: 'unsupported',
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  try {
    const run = await broker.instance.start('public input');
    await collect(broker.instance.events(run.runId));
    expect(broker.scriptErrors).toEqual([]);
  } finally {
    await broker.runtime.dispose();
  }
});
