// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import type {
  Component,
  JsonObject,
  MaterializedSurface,
  ProtocolErrorCode,
  SurfaceContext,
} from '../src/index.js';
import {
  A2UI_SPEC_REVISION,
  PROTOCOL_ERROR_CATEGORY,
  parseMessage,
  reduceBatch,
  validateSurface,
} from '../src/index.js';
import {
  catalog,
  code,
  context,
  create,
  data,
  deletion,
  freeze,
  run,
  schema,
  surface,
  update,
} from './catalog.js';
import { upstreamVectors } from './upstream-fixtures.js';

const text: Component = { id: 'root', component: 'Text', text: 'Hello' };
const child: Component = { id: 'child', component: 'Text', text: 'Hello' };
const column: Component = { id: 'root', component: 'Column', children: ['child'] };
const image = (url: string): Component => ({ id: 'root', component: 'Image', url });

// This explicit union assignment also checks completeness of the category map at compile time.
const categories: Readonly<
  Record<ProtocolErrorCode, 'invalid' | 'unsupported' | 'denied' | 'budget_exceeded'>
> = PROTOCOL_ERROR_CATEGORY;
const emitted = new Set<ProtocolErrorCode>();
function rejects(result: ReturnType<typeof reduceBatch>, expected: ProtocolErrorCode): void {
  expect(result).toMatchObject({ ok: false, code: expected });
  expect(result).not.toHaveProperty('surface');
  emitted.add(expected);
}

test('pinned upstream vectors replay through revisions 1, 2, 3 and the revision-4 deletion marker', () => {
  let previous: MaterializedSurface | undefined;
  upstreamVectors.forEach((message, index) => {
    previous = surface(reduceBatch(previous, [message], context));
    expect(previous.revision).toBe(index + 1);
    expect(previous.specRevision).toBe(A2UI_SPEC_REVISION);
    if (index === 0) expect(previous.dataModel).toEqual({ name: 'John Doe' });
    if (index === 1) {
      expect(previous.components['user_title']).toEqual({
        id: 'user_title',
        component: 'Text',
        text: 'Software Engineer',
      });
    }
    if (index === 2) {
      expect(previous.dataModel).toEqual({ name: 'John Doe', user: { name: 'Jane Doe' } });
    }
  });
  expect(previous).toMatchObject({ revision: 4, status: 'deleted', components: {}, dataModel: {} });
});

test('wire-order updates validate only the final candidate and increment once even for equal content', () => {
  const previous = surface(run([text]));
  const messages = [
    update([{ id: 'root', component: 'Text', text: { '@path': '/name' } }]),
    data({ name: 'Sam' }),
  ];
  const next = surface(reduceBatch(previous, messages, context));
  expect(next).toMatchObject({
    revision: 2,
    dataModel: { name: 'Sam' },
    components: { root: { text: { '@path': '/name' } } },
  });
  expect(surface(reduceBatch(next, [data({ name: 'Sam' })], context)).revision).toBe(3);
  expect(surface(reduceBatch(next, [deletion, create()], context)).revision).toBe(3);
});

test('deletion preserves identity and counter, recreation advances it', () => {
  const first = surface(run([text]));
  const deleted = surface(reduceBatch(first, [deletion], context));
  expect(deleted).toMatchObject({
    ...context.binding,
    revision: 2,
    status: 'deleted',
    components: {},
    dataModel: {},
  });
  expect(surface(reduceBatch(deleted, [create()], context)).revision).toBe(3);
  expect(validateSurface(deleted, context).ok).toBe(true);
});

test('atomic rejection and success never mutate deeply frozen inputs', () => {
  const previous = freeze(surface(run([text])));
  const before = JSON.stringify(previous);
  const messages = freeze([
    data({ name: 'Sam' }),
    {
      version: '1.0',
      updateComponents: { surfaceId: 'wrong', components: [] },
    },
  ]);
  expect(reduceBatch(previous, messages, freeze(context))).toEqual({
    ok: false,
    code: 'BINDING_MISMATCH',
    index: 1,
  });
  expect(JSON.stringify(previous)).toBe(before);
  const next = surface(reduceBatch(previous, freeze([data({ x: 2 })]), context));
  expect(next.dataModel).toEqual({ x: 2 });
  expect(previous.dataModel).toEqual({});
});

test('fixed message and binding errors contain only code and safe batch index', () => {
  const vectors: readonly [unknown, ProtocolErrorCode][] = [
    [null, 'INVALID_MESSAGE'],
    [{ version: '1.0', createSurface: {}, deleteSurface: {} }, 'INVALID_MESSAGE'],
    [{ version: '0.9', createSurface: {} }, 'UNSUPPORTED_VERSION'],
    [{ version: '1.0', callRendererFunction: {} }, 'UNSUPPORTED_RENDERER_MESSAGE'],
    [{ version: '1.0', agentFunctionResponse: {} }, 'UNSUPPORTED_AGENT_RESPONSE'],
    [
      {
        version: '1.0',
        createSurface: { surfaceId: 'user_profile_card', theme: {}, unknown: true },
      },
      'UNSUPPORTED_THEME',
    ],
    [
      {
        version: '1.0',
        createSurface: { surfaceId: 'user_profile_card', sendDataModel: false, unknown: true },
      },
      'DATA_MODEL_REQUIRED',
    ],
    [
      { version: '1.0', extra: true, createSurface: { surfaceId: 'user_profile_card' } },
      'UNKNOWN_FIELD',
    ],
    [
      { version: '1.0', deleteSurface: { surfaceId: 'user_profile_card', extra: true } },
      'UNKNOWN_FIELD',
    ],
    [{ version: '1.0', createSurface: { surfaceId: 'wrong' } }, 'BINDING_MISMATCH'],
    [
      { version: '1.0', createSurface: { surfaceId: 'user_profile_card', catalogId: 'wrong' } },
      'BINDING_MISMATCH',
    ],
  ];
  for (const [message, expected] of vectors) {
    rejects(reduceBatch(undefined, [message], context), expected);
  }
  rejects(reduceBatch(undefined, [], context), 'INVALID_MESSAGE');
  for (const message of [update([text]), data({}), deletion]) {
    rejects(reduceBatch(undefined, [message], context), 'INTEGRITY_ERROR');
  }
  const live = surface(run([text]));
  rejects(reduceBatch(live, [create()], context), 'INTEGRITY_ERROR');
  for (const message of [update([text]), data({}), deletion]) {
    rejects(
      reduceBatch(surface(reduceBatch(live, [deletion], context)), [message], context),
      'INTEGRITY_ERROR',
    );
  }
  rejects(run([{ ...text, catalogId: 'wrong' }]), 'BINDING_MISMATCH');
});

test('strict JSON rejects values, descriptors, cycles and class instances without invoking accessors', () => {
  class Custom {
    value = 1;
  }
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  let read = false;
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      read = true;
      return 1;
    },
  });
  const symbol = { [Symbol('x')]: 1 };
  const sparse = Array(2);
  for (const value of [
    undefined,
    () => 1,
    Symbol('x'),
    1n,
    NaN,
    Infinity,
    new Date(),
    new Custom(),
    cycle,
    getter,
    symbol,
    sparse,
  ]) {
    expect(
      parseMessage({
        version: '1.0',
        createSurface: { surfaceId: 'user_profile_card', dataModel: { value } },
      }),
    ).toEqual({ ok: false, code: 'INVALID_MESSAGE' });
  }
  expect(read).toBe(false);
});

test('own prototype-like keys are copied and updated without prototype pollution', () => {
  const model = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
  ) as JsonObject;
  const result = surface(run([text], model));
  expect(Object.hasOwn(result.dataModel, '__proto__')).toBe(true);
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  const updated = surface(reduceBatch(result, [data('safe', '/__proto__/label')], context));
  expect(updated.dataModel['__proto__']).toEqual({ polluted: true, label: 'safe' });
  expect(({} as Record<string, unknown>)['label']).toBeUndefined();
  expect(run([{ id: '__proto__', component: 'Text', text: 'safe' }, text]).ok).toBe(true);
});

test('extensions require registered schemas at both message and component metadata', () => {
  const message = {
    version: '1.0',
    createSurface: {
      surfaceId: 'user_profile_card',
      components: [text],
      metadata: { extensions: { host: { note: 'hello' } } },
    },
  };
  rejects(reduceBatch(undefined, [message], context), 'UNKNOWN_FIELD');
  const registered = {
    ...context,
    extensions: { host: schema((v) => typeof v['note'] === 'string') },
  };
  expect(reduceBatch(undefined, [message], registered).ok).toBe(true);
  const opaque = { ...context, extensions: { host: schema(() => true) } };
  const extensionData = {
    ...text,
    metadata: {
      extensions: { host: { '@call': 'callAgentFunction', '@path': 'bad~2', catalogId: 'opaque' } },
    },
  };
  const stored = surface(run([extensionData], {}, opaque));
  expect(validateSurface(stored, opaque).ok).toBe(true);
  rejects(run([{ ...text, metadata: { extensions: { unknown: {} } } }]), 'UNKNOWN_FIELD');
  rejects(run([{ ...text, metadata: { extra: {} } }]), 'UNKNOWN_FIELD');
});

test('catalog, graph and property error codes', () => {
  const vectors: readonly [readonly Component[], ProtocolErrorCode][] = [
    [[child], 'MISSING_ROOT'],
    [[column], 'UNRESOLVED_REFERENCE'],
    [[{ ...text, component: 'Unknown' }], 'UNKNOWN_COMPONENT'],
    [[{ ...text, component: 'Surface' }], 'UNKNOWN_COMPONENT'],
    [[{ ...text, unknown: 1 }], 'INVALID_COMPONENT_PROPERTY'],
    [[{ ...text, text: { '@path': '/missing' } }], 'INVALID_DATA_PATH'],
    [[text, text], 'DUPLICATE_COMPONENT_ID'],
    [[{ ...column, children: ['child', 'child'] }, child], 'DUPLICATE_COMPONENT_ID'],
    [[{ ...column, children: ['root'] }], 'CYCLIC_COMPONENTS'],
    [
      [
        text,
        { id: 'a', component: 'Card', child: 'b' },
        {
          id: 'b',
          component: 'Card',
          child: 'a',
        },
      ],
      'CYCLIC_COMPONENTS',
    ],
    [[{ id: 'root', component: 'Card', child: { '@path': '/id' } }], 'INVALID_COMPONENT_PROPERTY'],
  ];
  for (const [components, expected] of vectors) rejects(run(components), expected);
  const parent = {
    ...context,
    catalog: {
      ...catalog,
      components: {
        ...catalog.components,
        Text: { ...catalog.components['Text']!, allowedParents: ['Card'] },
      },
    },
  };
  rejects(run([column, child], {}, parent), 'UNALLOWED_PARENT');
  rejects(run([text], {}, parent), 'UNALLOWED_PARENT');
  const children = {
    ...context,
    catalog: {
      ...catalog,
      components: {
        ...catalog.components,
        Column: { ...catalog.components['Column']!, allowedChildren: ['Card'] },
      },
    },
  };
  rejects(run([column, child], {}, children), 'UNALLOWED_CHILD');
});

test('data pointers decode escapes, reject missing/scalar/invalid array parents, create missing object keys and delete predictably', () => {
  const initial = surface(run([text], { list: ['a', 'b'], scalar: 1, 'a/b': { '~key': 'ok' } }));
  const next = surface(
    reduceBatch(initial, [data('new', '/missing/deep/name'), data(null, '/list/0')], context),
  );
  expect(next.dataModel).toEqual({
    list: ['b'],
    scalar: 1,
    'a/b': { '~key': 'ok' },
    missing: { deep: { name: 'new' } },
  });
  expect(
    surface(reduceBatch(next, [data(null, '/missing/deep/name')], context)).dataModel['missing'],
  ).toEqual({ deep: {} });
  for (const path of ['/scalar/x', '/list/01', '/list/-', '/list/2', '/a~2b', 'relative']) {
    rejects(reduceBatch(initial, [data('x', path)], context), 'INVALID_DATA_PATH');
  }
  rejects(reduceBatch(initial, [data(null)], context), 'INVALID_DATA_PATH');
  expect(run([{ ...text, text: { '@path': '/a~1b/~0key' } }], initial.dataModel).ok).toBe(true);
  rejects(
    run([{ ...text, text: { '@path': '/scalar' } }], initial.dataModel),
    'INVALID_COMPONENT_PROPERTY',
  );
  for (const model of [{ '@bad': 1 }, { nested: [{ '@bad': 1 }] }]) {
    rejects(run([text], model), 'RESERVED_DATA_KEY');
  }
});

test('URL literals use caller policy and reject bindings before schema or policy', () => {
  rejects(run([image('https://evil.example/x')]), 'URL_NOT_ALLOWED');
  expect(run([image('https://images.example/x?query=yes')]).ok).toBe(true);
  rejects(
    run([{ ...image(''), url: { '@path': '/url' } }], { url: 'https://images.example/x' }),
    'URL_BINDING_FORBIDDEN',
  );
  rejects(
    run([{ ...image(''), url: { '@call': 'format', args: { text: 'x' } } }]),
    'URL_BINDING_FORBIDDEN',
  );
  for (const space of [' ', '\t', '\n', '\r', '\f', '\v']) {
    rejects(run([image(`https://images.example/${space}x`)]), 'URL_NOT_ALLOWED');
  }
  rejects(
    run(
      [image('https://images.example/x')],
      {},
      {
        ...context,
        isAllowedUrl() {
          throw new Error('sensitive');
        },
      },
    ),
    'URL_NOT_ALLOWED',
  );
});

test('byte caps include incoming batches, complete records, UTF-8 and previous components', () => {
  const small: SurfaceContext = { ...context, limits: { ...context.limits, payloadBytes: 200 } };
  rejects(run([{ ...text, text: 'x'.repeat(500) }], {}, small), 'PAYLOAD_TOO_LARGE');
  rejects(run([text], {}, small), 'PAYLOAD_TOO_LARGE'); // The envelope makes this larger than the incoming message.
  const full = surface(run([text]));
  const bytes = new TextEncoder().encode(JSON.stringify(full)).length;
  expect(
    run([text], {}, { ...context, limits: { ...context.limits, payloadBytes: bytes } }).ok,
  ).toBe(true);
  rejects(
    run([text], {}, { ...context, limits: { ...context.limits, payloadBytes: bytes - 1 } }),
    'PAYLOAD_TOO_LARGE',
  );
  const unicode = surface(run([{ ...text, text: 'é🌍' }]));
  const unicodeBytes = new TextEncoder().encode(JSON.stringify(unicode)).length;
  expect(
    run(
      [{ ...text, text: 'é🌍' }],
      {},
      {
        ...context,
        limits: { ...context.limits, payloadBytes: unicodeBytes },
      },
    ).ok,
  ).toBe(true);
  rejects(
    run([text, child], {}, { ...context, limits: { ...context.limits, components: 1 } }),
    'TOO_MANY_COMPONENTS',
  );
  rejects(
    reduceBatch(full, [update([child])], {
      ...context,
      limits: { ...context.limits, components: 1 },
    }),
    'TOO_MANY_COMPONENTS',
  );
});

const template: readonly Component[] = [
  { id: 'root', component: 'List', children: { componentId: 'item', path: '/users' } },
  { id: 'item', component: 'Column', children: ['name', 'index'] },
  { id: 'name', component: 'Text', text: { '@path': 'name' } },
  { id: 'index', component: 'Text', text: { '@call': '@index' } },
];

test('templates support relative and absolute bindings, escapes and scoped system index', () => {
  expect(run(template, { users: [{ name: 'One' }, { name: 'Two' }] }).ok).toBe(true);
  const absolute = template.map((c) =>
    c.id === 'name' ? { ...c, text: { '@path': '/a~1b/~0key' } } : c,
  );
  expect(run(absolute, { users: [{ name: 'One' }], 'a/b': { '~key': 'ok' } }).ok).toBe(true);
  rejects(run(template, { users: [{ name: 'One' }, {}] }), 'INVALID_DATA_PATH');
  rejects(run([{ ...text, text: { '@path': 'name' } }], { name: 'no' }), 'INVALID_DATA_PATH');
  rejects(run([{ ...text, text: { '@call': '@index' } }]), 'UNKNOWN_FUNCTION');
  expect(run(template, { users: [] }).ok).toBe(true);
  rejects(run(template, { users: 'not-array' }), 'INVALID_DATA_PATH');
});

test('template size is rejected before examining item bindings or running instance schemas', () => {
  const huge = { users: Array.from({ length: 10_000 }, () => ({})) };
  // Missing name would fail if the validator walked items before checking length.
  rejects(run(template, huge), 'TOO_MANY_COMPONENTS');
  const limit = { ...context, limits: { ...context.limits, components: 6 } };
  rejects(run(template, { users: [{ name: 'One' }] }, limit), 'TOO_MANY_COMPONENTS');
  expect(
    run(
      template,
      { users: [{ name: 'One' }] },
      {
        ...limit,
        limits: { ...limit.limits, components: 7 },
      },
    ).ok,
  ).toBe(true);
});

test('functions enforce registry, arguments, callers and actual action call sites without executing', () => {
  const call = (name: string, args: JsonObject = {}): Component => ({
    ...text,
    text: { '@call': name, args },
  });
  rejects(run([call('unknown')]), 'UNKNOWN_FUNCTION');
  rejects(run([call('secret')]), 'FUNCTION_CALLER_DENIED');
  rejects(run([call('open')]), 'USER_ACTIVATION_REQUIRED');
  rejects(run([call('format', { text: 1 })]), 'INVALID_FUNCTION_ARGUMENTS');
  rejects(
    run([{ ...text, text: { '@call': 'format', args: null } }]),
    'INVALID_FUNCTION_ARGUMENTS',
  );
  rejects(run([call('callAgentFunction')]), 'UNSUPPORTED_AGENT_FUNCTION');
  expect(run([call('format', { text: 'ok' })]).ok).toBe(true);
  const button: Component = {
    id: 'root',
    component: 'Button',
    action: { functionCall: { '@call': 'open' } },
  };
  expect(run([button]).ok).toBe(true);
  rejects(
    run([
      {
        ...button,
        action: { functionCall: { '@call': 'format', args: { text: { '@call': 'open' } } } },
      },
    ]),
    'USER_ACTIVATION_REQUIRED',
  );
  const eventArgs: SurfaceContext = {
    ...context,
    catalog: {
      ...catalog,
      functions: {
        ...catalog.functions,
        eventText: {
          allowedCallers: 'rendererOnly',
          args: schema((value) => typeof value['event'] === 'string'),
        },
      },
    },
  };
  expect(run([call('eventText', { event: 'plain argument' })], {}, eventArgs).ok).toBe(true);
  rejects(
    run([{ ...button, action: { callAgentFunction: { name: 'x' } } }]),
    'UNSUPPORTED_AGENT_FUNCTION',
  );
  rejects(
    run(
      [call('format', { text: 'ok' })],
      {},
      {
        ...context,
        catalog: {
          ...catalog,
          functions: {
            ...catalog.functions,
            bad: {
              allowedCallers: 'rendererOrAgent',
              requiresUserActivation: true,
              args: schema(() => true),
            },
          },
        },
      },
    ),
    'USER_ACTIVATION_REQUIRED',
  );
  rejects(
    run([{ ...text, text: { '@call': 'format', args: { text: 'ok' }, extra: 1 } }]),
    'INVALID_COMPONENT_PROPERTY',
  );
});

test('restore checks shape, binding, pins, graphs, paths, caps and deletion markers', () => {
  const current = surface(run([column, child]));
  expect(validateSurface(freeze(current), context)).toEqual({ ok: true, surface: current });
  rejects(validateSurface({ ...current, specRevision: 'future' }, context), 'UNSUPPORTED_VERSION');
  rejects(
    validateSurface({ ...current, components: { root: column } }, context),
    'UNRESOLVED_REFERENCE',
  );
  rejects(validateSurface({ ...current, region: 'other' }, context), 'BINDING_MISMATCH');
  rejects(
    validateSurface({ ...current, revision: Number.MAX_SAFE_INTEGER + 1 }, context),
    'INVALID_MESSAGE',
  );
  rejects(validateSurface({ ...current, status: 'deleted' }, context), 'INTEGRITY_ERROR');
  rejects(validateSurface({ ...current, extra: 'x' }, context), 'UNKNOWN_FIELD');
});

test('deterministic precedence: shape, binding, bytes, count, schema, graph, paths, functions and URL policy', () => {
  const tiny = { ...context, limits: { payloadBytes: 1, components: 0 } };
  rejects(
    reduceBatch(
      undefined,
      [{ version: '1.0', createSurface: { surfaceId: 'wrong', theme: {} } }],
      tiny,
    ),
    'UNSUPPORTED_THEME',
  );
  rejects(
    reduceBatch(undefined, [{ version: '1.0', createSurface: { surfaceId: 'wrong' } }], tiny),
    'BINDING_MISMATCH',
  );
  rejects(run([{ id: 'root', component: 'Unknown' }], {}, tiny), 'PAYLOAD_TOO_LARGE');
  rejects(
    run(
      [{ id: 'root', component: 'Unknown' }],
      {},
      {
        ...context,
        limits: { ...context.limits, components: 0 },
      },
    ),
    'TOO_MANY_COMPONENTS',
  );
  rejects(run([{ ...child, extra: true }]), 'INVALID_COMPONENT_PROPERTY');
  rejects(
    run([
      { ...text, text: { '@path': '/missing' } },
      {
        id: 'dangling',
        component: 'Card',
        child: 'no',
      },
    ]),
    'UNRESOLVED_REFERENCE',
  );
  rejects(
    run([
      image('https://evil.example/x'),
      {
        id: 'call',
        component: 'Text',
        text: { '@call': 'unknown' },
      },
    ]),
    'UNKNOWN_FUNCTION',
  );
});

test('strict common fields, data/model bindings and host schemas reject malformed nested values', () => {
  rejects(
    run([{ ...text, accessibility: { label: { '@path': '/label' }, extra: true } }], {
      label: 'ok',
    }),
    'INVALID_COMPONENT_PROPERTY',
  );
  rejects(
    run([{ ...text, accessibility: { label: { '@path': '/label' } } }], { label: 42 }),
    'INVALID_COMPONENT_PROPERTY',
  );
  expect(
    run(
      [
        {
          ...text,
          accessibility: { label: { '@path': '/label' }, live: 'polite', hidden: false },
        },
      ],
      { label: 'ok' },
    ).ok,
  ).toBe(true);
  rejects(
    run([{ ...text, text: { '@path': '/name', extra: true } }], { name: 'ok' }),
    'INVALID_COMPONENT_PROPERTY',
  );
  rejects(
    run([
      {
        id: 'root',
        component: 'Button',
        action: { event: { name: 'submit', unknown: true } },
      },
    ]),
    'INVALID_COMPONENT_PROPERTY',
  );
  expect(
    run([
      {
        id: 'root',
        component: 'Button',
        action: { event: { name: 'submit', userMessage: 'hello', context: { answer: 1 } } },
      },
    ]).ok,
  ).toBe(true);
  rejects(
    run([{ ...text, text: { callAgentFunction: { name: 'x' } } }]),
    'UNSUPPORTED_AGENT_FUNCTION',
  );
  const conflict: SurfaceContext = {
    ...context,
    catalog: {
      ...catalog,
      components: {
        ...catalog.components,
        Image: { ...catalog.components['Image']!, bindable: ['url'] },
      },
    },
  };
  rejects(run([text], {}, conflict), 'INVALID_COMPONENT_PROPERTY');
  const throwing: SurfaceContext = {
    ...context,
    catalog: {
      ...catalog,
      components: {
        Text: {
          props: schema(() => {
            throw new Error('private');
          }),
        },
      },
    },
  };
  expect(run([text], {}, throwing)).toEqual({ ok: false, code: 'INVALID_COMPONENT_PROPERTY' });
});

test('batch accessors stay uninvoked and candidate schemas cannot mutate messages', () => {
  let invoked = false;
  const messages = Object.defineProperty([], '0', {
    enumerable: true,
    get() {
      invoked = true;
      return create();
    },
  });
  expect(reduceBatch(undefined, messages, context)).toEqual({ ok: false, code: 'INVALID_MESSAGE' });
  expect(invoked).toBe(false);
  let calls = 0;
  const mutableSchema: SurfaceContext = {
    ...context,
    catalog: {
      ...catalog,
      components: {
        Text: {
          props: schema((value) => {
            calls++;
            value['text'] = 'changed';
            return true;
          }),
        },
      },
    },
  };
  const previous = freeze(surface(run([text])));
  const messages2 = freeze([update([text])]);
  const result = surface(reduceBatch(previous, messages2, mutableSchema));
  expect(result.components['root']).toEqual(text);
  expect(previous.components['root']).toEqual(text);
  // The plain candidate is checked once, without separately validating previous content.
  expect(calls).toBe(1);
});

test('nested template scopes, empty templates and shared ordinary graphs remain bounded', () => {
  const nested: readonly Component[] = [
    { id: 'root', component: 'List', children: { componentId: 'group', path: '/groups' } },
    { id: 'group', component: 'List', children: { componentId: 'name', path: 'users' } },
    { id: 'name', component: 'Text', text: { '@path': 'name' } },
  ];
  expect(run(nested, { groups: [{ users: [{ name: 'ok' }] }] }).ok).toBe(true);
  rejects(run(nested, { groups: [{ users: [{}] }] }), 'INVALID_DATA_PATH');
  const shared = [
    column,
    { id: 'child', component: 'Column', children: ['a', 'b'] },
    { id: 'a', component: 'Card', child: 'leaf' },
    { id: 'b', component: 'Card', child: 'leaf' },
    { id: 'leaf', component: 'Text', text: 'shared' },
  ] satisfies readonly Component[];
  expect(run(shared).ok).toBe(true);
  const emptyUnknown = template.map((component) =>
    component.id === 'index' ? { ...component, text: { '@call': 'unknown' } } : component,
  );
  rejects(run(emptyUnknown, { users: [] }), 'UNKNOWN_FUNCTION');
  const emptyExtra = template.map((component) =>
    component.id === 'name' ? { ...component, extra: true } : component,
  );
  rejects(run(emptyExtra, { users: [] }), 'INVALID_COMPONENT_PROPERTY');
  const emptyAbsolute = template.map((component) =>
    component.id === 'name' ? { ...component, text: { '@path': '/missing' } } : component,
  );
  rejects(run(emptyAbsolute, { users: [] }), 'INVALID_DATA_PATH');
  const boundChild = { ...column, children: { '@path': '/ids' } };
  rejects(run([boundChild, child], { ids: ['child'] }), 'INVALID_COMPONENT_PROPERTY');
});

test('restore and accepted no-op operations retain complete invariant checks', () => {
  const previous = surface(run([text], { values: ['one'], object: {} }));
  const absent = surface(reduceBatch(previous, [data(null, '/missing/path')], context));
  expect(absent.dataModel).toEqual(previous.dataModel);
  expect(absent.revision).toBe(2);
  expect(
    surface(reduceBatch(previous, [data({ replacement: true }, '')], context)).dataModel,
  ).toEqual({ replacement: true });
  rejects(
    reduceBatch({ ...previous, revision: Number.MAX_SAFE_INTEGER }, [data({})], context),
    'INTEGRITY_ERROR',
  );
  rejects(
    reduceBatch(undefined, [create([text, text]), deletion], context),
    'DUPLICATE_COMPONENT_ID',
  );
  rejects(
    validateSurface(
      {
        ...previous,
        components: { root: { ...text, metadata: { extensions: { unknown: {} } } } },
      },
      context,
    ),
    'UNKNOWN_FIELD',
  );
  rejects(
    validateSurface(previous, { ...context, limits: { ...context.limits, components: 0 } }),
    'TOO_MANY_COMPONENTS',
  );
});

test('extreme nesting fails with a content-free result instead of an uncaught stack error', () => {
  let model: JsonObject = {};
  for (let index = 0; index < 20_000; index++) model = { child: model };
  expect(reduceBatch(undefined, [create([text], model)], context)).toEqual({
    ok: false,
    code: 'INVALID_MESSAGE',
  });
});

test('category table retains the complete fixed code contract including renderer/core-owned codes', () => {
  const codes: readonly ProtocolErrorCode[] = [
    'INVALID_MESSAGE',
    'UNSUPPORTED_VERSION',
    'UNSUPPORTED_RENDERER_MESSAGE',
    'UNSUPPORTED_AGENT_RESPONSE',
    'UNSUPPORTED_THEME',
    'DATA_MODEL_REQUIRED',
    'UNKNOWN_FIELD',
    'BINDING_MISMATCH',
    'INTEGRITY_ERROR',
    'DUPLICATE_COMPONENT_ID',
    'UNKNOWN_COMPONENT',
    'INVALID_COMPONENT_PROPERTY',
    'MISSING_ROOT',
    'UNRESOLVED_REFERENCE',
    'CYCLIC_COMPONENTS',
    'UNALLOWED_PARENT',
    'UNALLOWED_CHILD',
    'INVALID_DATA_PATH',
    'RESERVED_DATA_KEY',
    'URL_BINDING_FORBIDDEN',
    'URL_NOT_ALLOWED',
    'PRIVATE_VALUE_IN_URL',
    'PAYLOAD_TOO_LARGE',
    'TOO_MANY_COMPONENTS',
    'UNKNOWN_FUNCTION',
    'FUNCTION_CALLER_DENIED',
    'USER_ACTIVATION_REQUIRED',
    'INVALID_FUNCTION_ARGUMENTS',
    'EXECUTION_ERROR',
    'UNSUPPORTED_AGENT_FUNCTION',
  ];
  expect(Object.keys(categories).sort()).toEqual([...codes].sort());
  for (const value of Object.values(categories)) {
    expect(['invalid', 'unsupported', 'denied', 'budget_exceeded']).toContain(value);
  }
  expect(categories.PRIVATE_VALUE_IN_URL).toBe('denied'); // Core distinguishes this using its private-value scan.
  expect(categories.EXECUTION_ERROR).toBe('invalid'); // Renderer execution, never validator evaluation.
  expect([...emitted].sort()).toEqual(
    codes.filter((c) => c !== 'PRIVATE_VALUE_IN_URL' && c !== 'EXECUTION_ERROR').sort(),
  );
  expect(code(run([text]))).toBeUndefined();
});
