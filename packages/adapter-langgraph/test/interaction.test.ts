// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { expect, test } from 'vitest';
import { installContext, requestInteraction, SynchronousContext } from '../src/interaction.js';

const key = Symbol.for('ls:tracing_async_local_storage');
const globals = globalThis as unknown as Record<symbol, unknown>;

test('context installation preserves a pre-existing global instance', () => {
  const previous = globals[key];
  const sentinel = {};
  try {
    globals[key] = sentinel;
    installContext();
    expect(globals[key]).toBe(sentinel);
  } finally {
    globals[key] = previous;
  }
});

test('runWithConfig exposes the config under the synchronous shim', () => {
  const previous = globals[key];
  const config = { configurable: { thread_id: 'test-thread' } };
  try {
    globals[key] = new SynchronousContext();
    expect(
      AsyncLocalStorageProviderSingleton.runWithConfig(config, () =>
        AsyncLocalStorageProviderSingleton.getRunnableConfig(),
      ),
    ).toBe(config);
    expect(AsyncLocalStorageProviderSingleton.getRunnableConfig()).toBeUndefined();
  } finally {
    globals[key] = previous;
  }
});

test('the shim restores the outer store after a callback throws', () => {
  const context = new SynchronousContext();
  const outer = {};
  context.enterWith(outer);
  expect(() =>
    context.run({}, () => {
      throw new Error('fixture');
    }),
  ).toThrow('fixture');
  expect(context.getStore()).toBe(outer);
});

test('malformed requests fail with invalid before interrupt is called', () => {
  expect(() => requestInteraction({ question: 'private-value' }, {})).toThrow(
    expect.objectContaining({ code: 'invalid', message: 'The interaction request is invalid.' }),
  );
});
