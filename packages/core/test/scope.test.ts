// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { acquireOwnership, watchInvalidation } from '@galaxie-ai/core/browser';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isValidScope } from '../src/ids.js';
import { createRuntime } from '../src/index.js';
import { definition, FakeExecutor } from './fake-executor.js';

const cases: ReadonlyArray<{
  readonly name: string;
  readonly value: unknown;
  readonly valid: boolean;
}> = [
  { name: 'plain identifier', value: 'app', valid: true },
  { name: 'allowed punctuation', value: 'a.b_c:d-e', valid: true },
  { name: '128 characters', value: 'a'.repeat(128), valid: true },
  { name: 'empty string', value: '', valid: false },
  { name: '129 characters', value: 'a'.repeat(129), valid: false },
  { name: 'space', value: 'bad id', valid: false },
  { name: 'slash', value: 'a/b', valid: false },
  { name: 'non-ASCII letter', value: 'a\u00e9', valid: false },
  { name: 'number', value: 12, valid: false },
  { name: 'null', value: null, valid: false },
  { name: 'undefined', value: undefined, valid: false },
  { name: 'object', value: {}, valid: false },
];
const invalidCases = cases.filter(({ valid }) => !valid);

afterEach(() => vi.restoreAllMocks());

describe('scope identifiers', () => {
  test.each(cases)('validates $name', ({ value, valid }) => {
    expect(isValidScope(value)).toBe(valid);
  });

  test.each(invalidCases)('rejects $name at runtime construction', ({ value }) => {
    expect(() => createRuntime({ appId: value as string, executors: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid', message: 'The application ID is invalid.' }),
    );
  });

  test.each(invalidCases)('rejects $name before creating an instance', async ({ value }) => {
    const executor = new FakeExecutor();
    const prepare = vi.spyOn(executor, 'prepare');
    const diagnostics = vi.fn();
    const runtime = createRuntime({ appId: 'app', executors: [executor], diagnostics });
    const mintId = vi.spyOn(globalThis.crypto, 'randomUUID');
    const readExecutor = vi.fn(() => executor.id);
    const readAgent = vi.fn(() => ({}));
    const readServices = vi.fn(() => ({}));
    try {
      await expect(
        runtime.create(
          {
            ...definition,
            get executor() {
              return readExecutor();
            },
          },
          {
            principalScope: value as string,
            get agent() {
              return readAgent();
            },
            get services() {
              return readServices();
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'invalid', message: 'The principal scope is invalid.' });
    } finally {
      await runtime.dispose();
    }
    expect(mintId).not.toHaveBeenCalled();
    expect(readExecutor).not.toHaveBeenCalled();
    expect(readAgent).not.toHaveBeenCalled();
    expect(readServices).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(executor.disposeCalls).toBe(0);
  });

  test.each(cases.filter(({ valid }) => valid))(
    'accepts $name for both runtime scopes',
    async ({ value }) => {
      const runtime = createRuntime({ appId: value as string, executors: [new FakeExecutor()] });
      try {
        const instance = await runtime.create(definition, {
          principalScope: value as string,
          agent: {},
        });
        expect(instance.getSnapshot().state).toBe('created');
      } finally {
        await runtime.dispose();
      }
    },
  );

  test('checks principal scope before the other create validations', async () => {
    const runtime = createRuntime({ appId: 'app', executors: [] });
    await runtime.dispose();
    await expect(
      runtime.create(definition, { principalScope: 'bad id', agent: {} }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'The principal scope is invalid.' });
  });

  test.each(invalidCases)('keeps the ownership error for $name', async ({ value }) => {
    await expect(
      acquireOwnership({ appId: value as string, onHandoverRequest: () => {} }),
    ).rejects.toMatchObject({ code: 'invalid', message: 'The request is invalid.' });
  });

  test.each(invalidCases)('keeps the invalidation errors for $name', ({ value }) => {
    for (const options of [
      { appId: value as string, principalScope: 'user' },
      { appId: 'app', principalScope: value as string },
    ])
      expect(() => watchInvalidation(options)).toThrowError(
        expect.objectContaining({ code: 'invalid', message: 'The request is invalid.' }),
      );
  });
});
