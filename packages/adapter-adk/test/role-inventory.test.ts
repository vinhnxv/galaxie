// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { LlmAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { createAdkAdapter } from '../src/adapter.js';
import { FakeChatModel } from './support/fixtures.js';

test.each(['set', 'defineProperty'] as const)(
  'writable exact-class proxies can defeat %s rollback',
  (operation) => {
    const first = new LlmAgent({ name: 'first', model: 'answer' });
    const second = new Proxy(new LlmAgent({ name: 'second', model: 'answer' }), {
      set(target, field, value) {
        if (field === 'model') {
          Object.defineProperty(first, 'model', { writable: false, configurable: false });
          throw new TypeError('Assignment refused.');
        }
        return Reflect.set(target, field, value);
      },
      defineProperty(target, field, descriptor) {
        if (field === 'model') {
          Object.defineProperty(first, 'model', { writable: false, configurable: false });
          throw new TypeError('Assignment refused.');
        }
        return Reflect.defineProperty(target, field, descriptor);
      },
    });
    for (const agent of [first, second]) {
      expect(Object.getPrototypeOf(agent)).toBe(LlmAgent.prototype);
      expect(Object.isSealed(agent)).toBe(false);
      expect(Object.isFrozen(agent)).toBe(false);
      expect(Object.getOwnPropertyDescriptor(agent, 'model')).toEqual({
        value: 'answer',
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    // A native assignment can make a previously validated sibling irreversible.
    // No browser API distinguishes this proxy from its exact-class target.
    const replacement = { model: 'replacement' };
    if (operation === 'set') {
      expect(Reflect.set(first, 'model', replacement)).toBe(true);
      expect(() => Reflect.set(second, 'model', replacement)).toThrow('Assignment refused.');
      expect(Reflect.set(first, 'model', 'answer')).toBe(false);
    } else {
      expect(Reflect.defineProperty(first, 'model', { value: replacement })).toBe(true);
      expect(() => Reflect.defineProperty(second, 'model', { value: replacement })).toThrow(
        'Assignment refused.',
      );
      expect(Reflect.defineProperty(first, 'model', { value: 'answer' })).toBe(false);
    }
    expect(first.model).toBe(replacement);
    expect(second.model).toBe('answer');
  },
);

test('real prepare keeps a string-model tree unchanged before assignment traps or requests', async () => {
  const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
  const store = { request: vi.fn(async () => null) };
  const first = new LlmAgent({ name: 'first', model: 'answer' });
  const assignment = vi.fn(() => {
    Object.defineProperty(first, 'model', { writable: false, configurable: false });
    throw new TypeError('Assignment refused.');
  });
  const second = new Proxy(new LlmAgent({ name: 'second', model: 'answer' }), {
    set(target, field, value) {
      if (field === 'model') return assignment();
      return Reflect.set(target, field, value);
    },
  });
  const root = new SequentialAgent({ name: 'root', subAgents: [first, second] });
  const before = [first, second].map((agent) => Object.getOwnPropertyDescriptor(agent, 'model'));
  await expect(
    createAdkAdapter().prepare(
      () => root,
      { chatModels: { mock: provider }, checkpoints: store },
      {
        signal: new AbortController().signal,
        models: { roles: ['answer'], providers: { mock: { credential: false } } },
      },
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect([first, second].map((agent) => Object.getOwnPropertyDescriptor(agent, 'model'))).toEqual(
    before,
  );
  expect(assignment).not.toHaveBeenCalled();
  expect(provider.seen).toEqual([]);
  expect(store.request).not.toHaveBeenCalled();
});
