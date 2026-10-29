// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { InteractionId, PendingInteraction, ViewRevision } from '@galaxie/core';
import type { ReactElement } from 'react';
import { expect, expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import { createRegistry, defineComponent } from '../src/index.js';

function pending(props: unknown, component = 'tests.Text/v1'): PendingInteraction {
  return {
    interactionId: 'registry' as InteractionId,
    surfaceId: 'lesson-main',
    viewRevision: 'r1' as ViewRevision,
    component: component as PendingInteraction['component'],
    props,
  };
}

const text = defineComponent({
  id: 'tests.Text/v1',
  props: z.strictObject({ title: z.string(), count: z.number().optional() }),
  actions: { submit: { label: 'Send answer', payload: z.object({ answer: z.string() }) } },
  component({ props, actions, status }): ReactElement | null {
    expectTypeOf(props.title).toEqualTypeOf<string>();
    expectTypeOf(actions.submit.submit).parameter(0).toEqualTypeOf<{ answer: string }>();
    expectTypeOf(status).toMatchTypeOf<string | { rejected: string }>();
    return null;
  },
});

test('the registry resolves validated schema output and preserves entry typing', () => {
  const registry = createRegistry({ components: [text], urlAllowlist: [] });
  expectTypeOf(text.id).toEqualTypeOf<'tests.Text/v1'>();
  const result = registry.resolve(pending({ title: 'Validated text', count: 2 }));
  expect(result).toMatchObject({ ok: true, props: { title: 'Validated text', count: 2 } });
  if (result.ok) expect(result.entry.component).toBe(text.component);
});

test('unknown component names never resolve through the object prototype', () => {
  const registry = createRegistry({ components: [text], urlAllowlist: [] });
  for (const id of ['tests.Unknown/v1', 'toString', '__proto__']) {
    expect(registry.resolve(pending({}, id))).toEqual({
      ok: false,
      error: { code: 'unsupported', message: 'This operation is unsupported.' },
    });
  }
});

test.each([{}, { title: 7 }, { title: 'props-canary', count: 'wrong' }, { title: 'x', extra: 1 }])(
  'missing and mistyped props are rejected without schema details',
  (props) => {
    const registry = createRegistry({ components: [text], urlAllowlist: [] });
    expect(registry.resolve(pending(props))).toEqual({
      ok: false,
      error: { code: 'invalid', message: 'The request is invalid.' },
    });
  },
);

test.each([
  z.string().refine(async () => true),
  z.string().refine(() => {
    throw new Error('refinement-canary');
  }),
  {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: async () => {
        throw new Error('async-schema-canary');
      },
    },
  },
])('asynchronous and throwing schemas fail synchronously with no retained cause', (props) => {
  const entry = defineComponent({
    id: 'tests.Text/v1',
    props,
    actions: {},
    component: (): ReactElement | null => null,
  });
  const result = createRegistry({ components: [entry], urlAllowlist: [] }).resolve(
    pending('props-canary'),
  );
  expect(result).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
  expect(JSON.stringify(result)).not.toMatch(/canary|issues|cause/);
});

const image = defineComponent({
  id: 'tests.Image/v1',
  props: z.object({ image: z.string() }),
  actions: {},
  urls: (props) => [props.image],
  component: (): ReactElement | null => null,
});

test('each declared URL uses the normalized exact-origin allowlist', () => {
  const urlAllowlist = ['https://IMAGES.example.test:443/'];
  const registry = createRegistry({ components: [image], urlAllowlist });
  urlAllowlist[0] = 'https://other.example.test';
  expect(
    registry.resolve(pending({ image: 'https://images.example.test/a.png' }, image.id)),
  ).toMatchObject({ ok: true });
  expect(
    createRegistry({ components: [image], urlAllowlist: [] }).resolve(
      pending({ image: 'https://images.example.test/url-canary' }, image.id),
    ),
  ).toEqual({ ok: false, error: { code: 'denied', message: 'Policy denied the request.' } });
});

test.each([
  'javascript:alert(1)',
  'data:text/html,url-canary',
  'https://images.example.test/a.png 1x, https://other.example.test/b.png 2x',
  'url(https://images.example.test/a.png)',
  'https://images.example.test/url-canary\t',
  'https://images.example.test/url-canary\n',
  'https://images.example.test/url-canary\r',
  'https://images.example.test/url-canary\f',
  'https://images.example.test/url-canary\v',
  'https://images.example.test/url-canary ',
])('URL strings are single attribute values, not executable or compound syntax', (url) => {
  const registry = createRegistry({
    components: [image],
    urlAllowlist: ['https://images.example.test'],
  });
  const result = registry.resolve(pending({ image: url }, image.id));
  expect(result).toEqual({
    ok: false,
    error: { code: 'denied', message: 'Policy denied the request.' },
  });
  expect(JSON.stringify(result)).not.toMatch(/url-canary|images\.example|alert|data:|cause/);
});

test('a throwing URL extractor produces a fixed invalid error', () => {
  const entry = defineComponent({
    ...image,
    urls: () => {
      throw new Error('extractor-canary');
    },
  });
  const result = createRegistry({ components: [entry], urlAllowlist: [] }).resolve(
    pending({ image: 'props-canary' }, image.id),
  );
  expect(result).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
  expect(JSON.stringify(result)).not.toMatch(/canary|cause/);
});

test('bindings use every entry action and the same payload schemas', () => {
  const surfaces = ['lesson-main'];
  const registry = createRegistry({ components: [text, image], urlAllowlist: [] });
  const bindings = registry.bindings({ surfaces });
  surfaces.push('sidebar');
  expect(bindings.surfaces).toEqual(['lesson-main']);
  expect(Object.keys(bindings.components)).toEqual([text.id, image.id]);
  expect(bindings.components[text.id]?.actions['submit']?.payload).toBe(
    text.actions.submit.payload,
  );
  expect(bindings.components[image.id]?.actions).toEqual({});
});

test.each([
  { components: [text, text] },
  { components: [{ ...text, id: 'invalid-id' }] },
  { components: [{ ...text, component: 'component-canary' }] },
  { components: [{ ...text, props: {} }] },
  { components: [{ ...text, actions: { submit: { label: '', payload: z.string() } } }] },
  { components: [{ ...text, actions: { '': { label: 'Send', payload: z.string() } } }] },
  { components: [{ ...text, actions: { submit: { label: 'Send', payload: {} } } }] },
])('malformed registry entries reject with a typed, content-free error', ({ components }) => {
  let error: unknown;
  try {
    createRegistry({ components } as unknown as Parameters<typeof createRegistry>[0]);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ name: 'GalaxieError', code: 'invalid' });
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toMatch(/canary|invalid-id|issues/);
});

test.each(['https://images.example.test/path', 'javascript:', 'http://images.example.test'])(
  'the registry uses the same allowlist configuration rules as core',
  (origin) => {
    expect(() => createRegistry({ components: [image], urlAllowlist: [origin] })).toThrowError(
      expect.objectContaining({ code: 'invalid' }),
    );
  },
);
