// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type CapabilityContext, readAnnotations } from '@galaxie/core';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  capabilityRequests,
  createHostCapabilities,
  RESULT_BYTES,
  RESULT_ITEMS,
} from '../src/host/capabilities.js';
import { hostModels } from '../src/host/runtime.js';

const context: CapabilityContext = {
  principalScope: 'fixture-principal',
  effectId: 'fixture-effect' as CapabilityContext['effectId'],
  runId: 'fixture-run' as CapabilityContext['runId'],
  agent: { id: 'fixture', version: '1.0.0', hash: 'fixture-hash' },
  signal: new AbortController().signal,
};
const host = (): ReturnType<typeof createHostCapabilities> =>
  createHostCapabilities('fixture-principal');

test('search returns matching synthetic data marked as untrusted, with bounded empty results', async () => {
  const binding = host().bindings['market.search@1'];
  const result = await binding.invoke({ query: 'Lantern Orchard' }, context);
  expect(result).toMatchObject({
    status: 'ok',
    truncated: false,
    marker: '',
    trust: 'untrusted-tool-output',
  });
  expect(result.items.map((item) => item.id)).toEqual(['bulletin-lantern']);
  expect(await binding.invoke({ query: 'nothing-matches' }, context)).toMatchObject({
    items: [],
    truncated: false,
  });
});

test.each(['', '  ', 'x'.repeat(161)])(
  'rejects invalid query with a fixed content-free error',
  async (query) => {
    await expect(
      host().bindings['market.search@1'].invoke({ query }, context),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'The capability arguments are invalid.',
    });
  },
);

test('search caps result count and complete UTF-8 envelope size with a visible marker', async () => {
  expect(RESULT_ITEMS).toBe(5);
  expect(RESULT_BYTES).toBe(4096);
  const binding = host().bindings['market.search@1'];
  const many = await binding.invoke({ query: 'synthetic' }, context);
  expect(many.items).toHaveLength(RESULT_ITEMS);
  expect(many).toMatchObject({ truncated: true, marker: '[truncated]' });
  const large = await binding.invoke({ query: 'oversized-fixture' }, context);
  expect(large).toMatchObject({ items: [], truncated: true, marker: '[truncated]' });
  for (const result of [many, large])
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
      RESULT_BYTES,
    );
});

test.each(['loan.documents@1', 'loan.business@1'] as const)(
  'loan read %s uses fixed not-found and returns isolated fixture data',
  async (name) => {
    const binding = host().bindings[name];
    expect(await binding.invoke({ applicationId: 'application-unknown' }, context)).toEqual({
      status: 'not_found',
      items: [],
      truncated: false,
      marker: '',
    });
    const first = await binding.invoke({ applicationId: 'application-lantern' }, context);
    expect(first.status).toBe('ok');
    expect(first.items.length).toBeGreaterThan(0);
    first.items.length = 0;
    expect(
      (await binding.invoke({ applicationId: 'application-lantern' }, context)).items.length,
    ).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(
      RESULT_BYTES,
    );
  },
);

test.each([
  [300, 'review', 12.5],
  [649, 'review', 12.5],
  [650, 'standard', 9.5],
  [749, 'standard', 9.5],
  [750, 'preferred', 6.5],
  [850, 'preferred', 6.5],
])(
  'synthetic pricing at score %s selects %s without writing',
  async (creditScore, tier, annualRatePercent) => {
    const fixture = host();
    expect(
      await fixture.bindings['loan.price@1'].invoke(
        { creditScore: Number(creditScore), amount: 40000, termMonths: 36 },
        context,
      ),
    ).toEqual({ tier, annualRatePercent });
    expect(fixture.bindings['loan.price@1'].kind).toBe('read');
    expect(fixture.decisions()).toEqual([]);
  },
);

test.each([
  { creditScore: 299 },
  { creditScore: 851 },
  { creditScore: 650.5 },
  { amount: 999 },
  { amount: 250001 },
  { termMonths: 11 },
  { termMonths: 61 },
])('pricing rejects out-of-range input %o', async (input) => {
  await expect(
    host().bindings['loan.price@1'].invoke(
      { creditScore: 700, amount: 40000, termMonths: 36, ...input },
      context,
    ),
  ).rejects.toMatchObject({ code: 'invalid', message: 'The capability arguments are invalid.' });
});

test('schemas carry public search, private loan results and bounded argument shapes', () => {
  const search = capabilityRequests['market.search@1'];
  expect(z.toJSONSchema(search.output).properties?.['items']).toMatchObject({
    items: { 'x-galaxie': { label: 'public' } },
  });
  expect(z.toJSONSchema(search.input).properties?.['query']).toMatchObject({
    'x-galaxie': { shape: 'freeText' },
  });
  for (const name of ['loan.documents@1', 'loan.business@1'] as const) {
    const request = capabilityRequests[name];
    expect(z.toJSONSchema(request.output).properties?.['items']).toMatchObject({
      items: { 'x-galaxie': { label: 'private-user' } },
    });
    expect(z.toJSONSchema(request.input).properties?.['applicationId']).toMatchObject({
      'x-galaxie': { label: 'private-user', shape: 'id' },
    });
  }
  for (const name of ['loan.price@1', 'loan.finalize@1'] as const)
    expect(z.toJSONSchema(capabilityRequests[name].output)).toMatchObject({
      'x-galaxie': { label: 'private-user' },
    });
});

test('core accepts every capability schema and recognizes the bounded application ID', () => {
  for (const request of Object.values(capabilityRequests)) {
    expect(() => readAnnotations(request.input)).not.toThrow();
    expect(() => readAnnotations(request.output)).not.toThrow();
  }
  expect(
    readAnnotations(capabilityRequests['loan.documents@1'].input).properties.get('applicationId'),
  ).toBe('id');
});

test('only finalization is a confirmation-required retry-none write; records are host scoped', async () => {
  const fixture = host();
  for (const [name, binding] of Object.entries(fixture.bindings))
    expect(binding).toMatchObject({
      destination: 'in-browser',
      retry: 'none',
      kind: name === 'loan.finalize@1' ? 'write' : 'read',
      approval: name === 'loan.finalize@1' ? 'confirm' : 'none',
    });
  const binding = fixture.bindings['loan.finalize@1'];
  await expect(
    binding.invoke({ applicationId: 'application-unknown', decision: 'approved' }, context),
  ).rejects.toMatchObject({ code: 'invalid', message: 'The application was not found.' });
  expect(fixture.decisions()).toEqual([]);
  const input = { applicationId: 'application-lantern', decision: 'approved' as const };
  expect(await binding.invoke(input, context)).toEqual({ ...input, finalized: true });
  expect(fixture.decisions()).toEqual([{ ...input, finalized: true }]);
  expect(Object.isFrozen(fixture.decisions()[0])).toBe(true);
  await expect(binding.invoke({ ...input, decision: 'denied' }, context)).rejects.toMatchObject({
    code: 'denied',
  });
  expect(host().decisions()).toEqual([]);
});

test('principal mismatch and cancellation refuse a write before changing records', async () => {
  const fixture = host();
  const input = { applicationId: 'application-lantern', decision: 'approved' as const };
  const binding = fixture.bindings['loan.finalize@1'];
  await expect(
    binding.invoke(input, { ...context, principalScope: 'another-principal' }),
  ).rejects.toMatchObject({ code: 'denied' });
  await expect(
    binding.invoke(input, { ...context, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(fixture.decisions()).toEqual([]);
});

test('strict shapes reject unexpected fields and invalid IDs', () => {
  expect(
    capabilityRequests['loan.documents@1'].input.safeParse({ applicationId: '../secret' }).success,
  ).toBe(false);
  expect(
    capabilityRequests['loan.finalize@1'].input.safeParse({
      applicationId: 'application-lantern',
      decision: 'approved',
      principal: 'override',
    }).success,
  ).toBe(false);
});

test('default mode offers no missing provider; only mock mode constructs the deterministic model', () => {
  for (const mode of ['production', 'development', ''])
    expect(hostModels(mode)).toEqual({ providers: {}, chatModels: {} });
  const mock = hostModels('mock');
  expect(Object.keys(mock.providers)).toEqual(['mock']);
  expect(Object.keys(mock.chatModels)).toEqual(['mock']);
  expect(mock.providers['mock']).toMatchObject({ destination: 'in-browser' });
});
