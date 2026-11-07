// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { expect, test, vi } from 'vitest';
import { resolveProvider } from '../src/index.js';

const model = { invoke: vi.fn() } as unknown as BaseChatModel;

test('provider lookup uses own properties and fixed missing-provider failures', () => {
  const providers = Object.create({ inherited: model }) as Record<string, BaseChatModel>;
  providers['own'] = model;
  expect(resolveProvider(providers, { providerId: 'own' })).toBe(model);
  for (const providerId of ['inherited', 'missing', 'toString'])
    expect(() => resolveProvider(providers, { providerId })).toThrowError(
      expect.objectContaining({ code: 'unavailable' }),
    );
});

test('factory requires a credential and receives only that credential on every call', () => {
  const factory = vi.fn(() => model);
  expect(() => resolveProvider({ selected: factory }, { providerId: 'selected' })).toThrowError(
    expect.objectContaining({ code: 'invalid' }),
  );
  expect(factory).not.toHaveBeenCalled();
  const lease = { providerId: 'selected', credential: 'ephemeral-private-value' };
  expect(resolveProvider({ selected: factory }, lease)).toBe(model);
  expect(resolveProvider({ selected: factory }, lease)).toBe(model);
  expect(factory.mock.calls).toEqual([
    [{ credential: lease.credential }],
    [{ credential: lease.credential }],
  ]);
  expect(model).not.toHaveProperty('credential');
  expect(model.invoke).not.toHaveBeenCalled();
});

test('an already constructed provider receives no credential', () => {
  expect(
    resolveProvider({ selected: model }, { providerId: 'selected', credential: 'private' }),
  ).toBe(model);
  expect(model).not.toHaveProperty('credential');
});
