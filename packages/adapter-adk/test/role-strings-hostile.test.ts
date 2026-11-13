// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import type { RunId, SessionId } from '@galaxie-ai/core';
import { type BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { createAdkAdapter } from '../src/adapter.js';
import { admitRoleStrings } from '../src/admission.js';
import { createHost } from '../src/host.js';
import { defineAdkEntry } from '../src/interaction.js';
import { FakeChatModel, fakeModels, fakeTrace } from './support/fixtures.js';

const models = { roles: ['answer'], providers: { mock: { credential: false } } };
const options = { signal: new AbortController().signal, models };
const services = (): { chatModels: { mock: FakeChatModel } } => ({
  chatModels: { mock: new FakeChatModel(() => new AIMessage({ content: 'done' })) },
});

function structural(root: object) {
  const seen = new Set<object>();
  const objects: { object: object; descriptors: PropertyDescriptorMap; extensible: boolean }[] = [];
  const walk = (object: object): void => {
    if (seen.has(object)) return;
    seen.add(object);
    const descriptors = Object.getOwnPropertyDescriptors(object);
    objects.push({ object, descriptors, extensible: Object.isExtensible(object) });
    for (const descriptor of Object.values(descriptors)) {
      const value: unknown = descriptor.value;
      if (typeof value === 'object' && value !== null) walk(value);
    }
  };
  walk(root);
  return objects;
}

async function run(prepared: Awaited<ReturnType<ReturnType<typeof createAdkAdapter>['prepare']>>) {
  const leases = fakeModels();
  const events = [];
  for await (const event of prepared.run({
    runId: 'run' as RunId,
    sessionId: 's' as SessionId,
    command: { type: 'start', input: { prompt: 'question' } },
    signal: new AbortController().signal,
    trace: fakeTrace().trace,
    models: leases.port,
    limits: { steps: 10 },
    capabilities: {
      async call(): Promise<never> {
        throw new Error('No capability expected.');
      },
    },
  }))
    events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'output', output: 'done' });
  return leases.leases;
}

test('exact class admission precedes every subclass property read', async () => {
  class Foreign extends LlmAgent {}
  const reads = vi.fn();
  const author = new Proxy(new Foreign({ name: 'root', model: 'answer' }), {
    get(target, key, receiver) {
      reads(key);
      return Reflect.get(target, key, receiver);
    },
  });
  await expect(
    createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: author, roleStrings: true }),
      services(),
      options,
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(reads).not.toHaveBeenCalled();
});

test.each([
  'parent',
  'model-accessor',
  'instruction-accessor',
  'repeated',
  'cycle',
  'depth',
  'count',
])('malformed %s trees fail without author effects', async (kind) => {
  let root: BaseAgent = new LlmAgent({ name: 'root', model: 'answer' });
  const accessor = vi.fn(() => 'answer');
  if (kind === 'parent') new SequentialAgent({ name: 'parent', subAgents: [root] });
  if (kind === 'model-accessor' || kind === 'instruction-accessor')
    Object.defineProperty(root, kind === 'model-accessor' ? 'model' : 'instruction', {
      get: accessor,
      configurable: true,
    });
  if (kind === 'repeated')
    Reflect.set(root, 'subAgents', [new LlmAgent({ name: 'child', model: 'answer' })]);
  if (kind === 'repeated') root.subAgents.push(root.subAgents[0] as BaseAgent);
  if (kind === 'cycle') root.subAgents.push(root);
  if (kind === 'depth')
    for (let index = 0; index < 17; index += 1)
      root = new SequentialAgent({ name: `level_${index}`, subAgents: [root] });
  if (kind === 'count')
    root = new SequentialAgent({
      name: 'root',
      subAgents: Array.from(
        { length: 256 },
        (_, index) => new LlmAgent({ name: `child_${index}`, model: 'answer' }),
      ),
    });
  const before = structural(root);
  await expect(
    createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: root, roleStrings: true }),
      services(),
      options,
    ),
  ).rejects.toMatchObject({
    code: ['cycle', 'depth', 'count'].includes(kind) ? 'invalid' : 'unsupported',
  });
  expect(structural(root)).toEqual(before);
  expect(accessor).not.toHaveBeenCalled();
});

test('hostile exact-class Proxies receive no write-class operations through prepare run or dispose', async () => {
  const writes = vi.fn(() => {
    throw new Error('Author writes are forbidden.');
  });
  const first = new LlmAgent({ name: 'first', model: 'answer' });
  const second = new LlmAgent({ name: 'second', model: 'answer' });
  const wrap = (target: LlmAgent, sibling: LlmAgent): LlmAgent =>
    new Proxy(target, {
      set: writes,
      defineProperty: writes,
      deleteProperty: writes,
      setPrototypeOf: writes,
      preventExtensions: writes,
      get(object, key, receiver) {
        if (key === 'model') Object.freeze(sibling);
        return Reflect.get(object, key, receiver);
      },
    });
  const root = new SequentialAgent({ name: 'root' });
  Reflect.set(root, 'subAgents', [wrap(first, second), wrap(second, first)]);
  const before = structural(root);
  const prepared = await createAdkAdapter().prepare(
    () => defineAdkEntry({ agent: root, roleStrings: true }),
    services(),
    options,
  );
  expect(structural(root)).toEqual(before);
  await run(prepared);
  expect(structural(root)).toEqual(before);
  await prepared.dispose();
  expect(structural(root)).toEqual(before);
  expect(writes).not.toHaveBeenCalled();
});

test.each(['freeze', 'seal'] as const)(
  '%s author agents execute through mutable host copies',
  async (operation) => {
    const child = new LlmAgent({ name: 'child', model: 'answer' });
    const root = new SequentialAgent({ name: 'root', subAgents: [child] });
    if (operation === 'freeze') {
      Object.freeze(child);
      Object.freeze(root);
    } else {
      Object.seal(child);
      Object.seal(root);
    }
    const before = structural(root);
    const prepared = await createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: root, roleStrings: true }),
      services(),
      options,
    );
    await run(prepared);
    await prepared.dispose();
    expect(structural(root)).toEqual(before);
  },
);

test('the same author tree prepares repeatedly and concurrently with host-specific roles', async () => {
  const author = new LlmAgent({ name: 'root', model: 'answer' });
  const factory = () => defineAdkEntry({ agent: author, roleStrings: true });
  const before = structural(author);
  for (let index = 0; index < 2; index += 1) {
    const prepared = await createAdkAdapter().prepare(factory, services(), options);
    expect((await run(prepared))[0]?.role).toBe('answer');
    await prepared.dispose();
  }
  const a = services();
  const b = services();
  const [first, second] = await Promise.all([
    createAdkAdapter().prepare(factory, a, options),
    createAdkAdapter().prepare(factory, b, {
      ...options,
      models: { ...models, roles: ['answer', 'second'] },
    }),
  ]);
  await Promise.all([run(first), run(second)]);
  await first.dispose();
  await run(second);
  expect(a.chatModels.mock.seen).toHaveLength(1);
  expect(b.chatModels.mock.seen).toHaveLength(2);
  await second.dispose();
  expect(structural(author)).toEqual(before);
});

test.each([LlmAgent, SequentialAgent, ParallelAgent, LoopAgent])(
  '%s copies every live own field and retains ADK identity behavior',
  (Class) => {
    const provider = services();
    const { host } = createHost(
      provider,
      models,
      () => undefined,
      () => 's',
    );
    const child = new LlmAgent({ name: 'child', model: 'answer' });
    const author = new Class({ name: 'root', model: 'answer', subAgents: [child] });
    const copy = admitRoleStrings(author, host, models.roles) as BaseAgent;
    expect(Reflect.ownKeys(copy)).toEqual(Reflect.ownKeys(author));
    for (const key of Reflect.ownKeys(author)) {
      if (['model', 'parentAgent', 'subAgents', 'config'].includes(String(key))) continue;
      expect(Reflect.get(copy, key)).toEqual(Reflect.get(author, key));
      if (Array.isArray(Reflect.get(author, key)))
        expect(Reflect.get(copy, key)).not.toBe(Reflect.get(author, key));
    }
    expect(copy).toBeInstanceOf(Class);
    expect(copy.findSubAgent('child')).toBe(copy.subAgents[0]);
    expect(copy.subAgents[0]?.rootAgent).toBe(copy);
    expect(Reflect.get(copy, Symbol.for('google.adk.baseAgent'))).toBe(true);
    for (const agent of [copy, ...copy.subAgents]) {
      const config = Reflect.get(agent, 'config') as Record<string, unknown>;
      expect(typeof config['model']).not.toBe('string');
      expect(config['subAgents']).toBe(agent.subAgents);
      expect(config['subAgents']).not.toContain(child);
    }
  },
);

test('live instruction wins over construction config without author clone constructor or config reads during execution', async () => {
  const calls = vi.fn(() => {
    throw new Error('Author construction is forbidden.');
  });
  const reads = vi.fn();
  const root = new LlmAgent({ name: 'root', model: 'answer', instruction: 'old instruction' });
  root.instruction = 'changed instruction';
  Object.defineProperty(root, 'clone', { value: calls, enumerable: true });
  Object.defineProperty(root, 'constructor', { value: calls, enumerable: true });
  const author = new Proxy(root, {
    get(target, key, receiver) {
      if (['config', 'constructor', 'clone'].includes(String(key))) reads(key);
      return Reflect.get(target, key, receiver);
    },
  });
  const service = services();
  const before = structural(root);
  const prepared = await createAdkAdapter().prepare(
    () => defineAdkEntry({ agent: author, roleStrings: true }),
    service,
    options,
  );
  await run(prepared);
  await prepared.dispose();
  expect(
    service.chatModels.mock.seen[0]?.messages.find((message) => message.type === 'system')?.content,
  ).toContain('changed instruction');
  expect(calls).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
  expect(structural(root)).toEqual(before);
});

test('author arrays never consult constructor species and host arrays retain plain prototypes', () => {
  const { host } = createHost(
    services(),
    models,
    () => undefined,
    () => 's',
  );
  const species = vi.fn(() => Array);
  const root = new LlmAgent({ name: 'root', model: 'answer', beforeModelCallback: [] });
  const arrayConstructor = Object.defineProperty({}, Symbol.species, { get: species });
  for (const value of [
    root.tools,
    root.subAgents,
    root.beforeModelCallback,
    root.requestProcessors,
  ])
    if (Array.isArray(value))
      Object.defineProperty(value, 'constructor', { value: arrayConstructor });
  const copy = admitRoleStrings(root, host, models.roles) as LlmAgent;
  for (const value of [
    copy.tools,
    copy.subAgents,
    copy.beforeModelCallback,
    copy.requestProcessors,
  ])
    if (Array.isArray(value)) expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
  expect(species).not.toHaveBeenCalled();
});

test('ADK execution does not read config or invoke clone or constructor on the host-owned copy', async () => {
  const reads = vi.fn();
  const original = LlmAgent.prototype.runAsync;
  const spy = vi.spyOn(LlmAgent.prototype, 'runAsync').mockImplementation(function (
    this: LlmAgent,
    context,
  ) {
    const guarded = new Proxy(this, {
      get(target, key, receiver) {
        if (['config', 'clone', 'constructor'].includes(String(key))) reads(key);
        return Reflect.get(target, key, receiver);
      },
    });
    return original.call(guarded, context);
  });
  try {
    const prepared = await createAdkAdapter().prepare(
      () =>
        defineAdkEntry({
          agent: new LlmAgent({ name: 'root', model: 'answer' }),
          roleStrings: true,
        }),
      services(),
      options,
    );
    await run(prepared);
    await prepared.dispose();
    expect(spy).toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test.each(['tools', 'subAgents', 'beforeModelCallback'])(
  '%s holey or accessor-element arrays refuse without invoking accessors',
  async (field) => {
    for (const accessor of [false, true]) {
      const root = new LlmAgent({ name: 'root', model: 'answer' });
      const get = vi.fn(() => undefined);
      const array = new Array(1);
      if (accessor) Object.defineProperty(array, '0', { get });
      Reflect.set(root, field, array);
      await expect(
        createAdkAdapter().prepare(
          () => defineAdkEntry({ agent: root, roleStrings: true }),
          services(),
          options,
        ),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(get).not.toHaveBeenCalled();
    }
  },
);
