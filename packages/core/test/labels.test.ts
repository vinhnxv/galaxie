// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  DEFAULT_DATA_POLICY,
  type DestinationClass,
  galaxieField,
  inBrowserOnly,
  labelsAllow,
} from '../src/index.js';
import { binding, brokerFixture, collect, deferred, FakeExecutor, flush } from './fake-executor.js';

const destinations: DestinationClass[] = [
  'in-browser',
  'user-device',
  'user-endpoint',
  'host-server',
  'third-party',
];
for (const label of ['public', 'app', 'private-user'] as const)
  for (const destination of destinations)
    test(`${label} free text follows policy for ${destination}`, async () => {
      const invoke = vi.fn(async (input: unknown) => input);
      const allowed = DEFAULT_DATA_POLICY[label].allow.includes(destination);
      const fixture = await brokerFixture({
        input: z.string().meta(galaxieField({ label })),
        bindings: { 'echo@1': binding({ destination, invoke }) },
        scripts: [
          async function* ({ capabilities }) {
            const call = capabilities.call('echo@1', 'unrelated text');
            if (allowed) await expect(call).resolves.toBe('unrelated text');
            else await expect(call).rejects.toMatchObject({ code: 'denied' });
            yield { type: 'output', output: null };
          },
        ],
      });
      const { runId } = await fixture.instance.start('input private value');
      await collect(fixture.instance.events(runId));
      await fixture.runtime.dispose();
      expect(fixture.scriptErrors).toEqual([]);
      expect(invoke).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });

test('AE2 private free text stays local and the guard blocks an ID-shaped verbatim handle', async () => {
  const input = z.object({
    note: z.string().meta(galaxieField({ label: 'private-user' })),
    handle: z.string().meta(galaxieField({ label: 'private-user' })),
  });
  const text = { input: z.string(), output: z.string(), kind: 'read' as const };
  const id = {
    ...text,
    input: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(64),
  };
  const fixture = await brokerFixture({
    input,
    requests: { 'remote@1': text, 'local@1': text, 'id@1': id },
    bindings: {
      'remote@1': binding({ destination: 'host-server' }),
      'local@1': binding(),
      'id@1': binding({ destination: 'host-server' }),
    },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('remote@1', 'query')).rejects.toMatchObject({
          code: 'denied',
        });
        await expect(capabilities.call('local@1', 'query')).resolves.toBe('query');
        await expect(capabilities.call('id@1', 'cat-lover-2049')).rejects.toMatchObject({
          code: 'denied',
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start({
    note: 'My secret sentence about cats',
    handle: 'Cat-Lover-2049',
  });
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('labels are sticky, value-insensitive, sorted and isolated to a run', async () => {
  const fixture = await brokerFixture({
    input: z.object({
      public: z.string().meta(galaxieField({ label: 'public' })),
      absent: z
        .string()
        .meta(galaxieField({ label: 'private-user' }))
        .optional(),
    }),
    requests: { 'echo@1': { input: z.string(), output: z.string(), kind: 'read' } },
    scripts: [
      async function* ({ capabilities }) {
        await capabilities.call('echo@1', 'unlabelled output');
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start({ public: 'x' });
  await collect(fixture.instance.events(runId));
  expect(fixture.instance.getSnapshot().run?.labels).toEqual(['app', 'private-user', 'public']);
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('partial data policy replaces only named labels and invalid keys reject', async () => {
  const fixture = await brokerFixture({
    input: z.string().meta(galaxieField({ label: 'private-user' })),
    dataPolicy: { 'private-user': { allow: ['host-server'] } },
    bindings: { 'echo@1': binding({ destination: 'host-server' }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'query')).resolves.toBe('query');
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('private input');
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  for (const dataPolicy of [
    { secret: { allow: ['in-browser'] } },
    { app: { allow: ['bad'] } },
    { app: { allow: null } },
  ])
    expect(() =>
      createRuntime({
        appId: 'test',
        executors: [new FakeExecutor()],
        dataPolicy: dataPolicy as never,
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid' }));
  const app = await brokerFixture({
    dataPolicy: { 'private-user': { allow: ['host-server'] } },
    bindings: { 'echo@1': binding({ destination: 'third-party' }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', 'query')).rejects.toMatchObject({
          code: 'denied',
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  const run = await app.instance.start('app input');
  await collect(app.instance.events(run.runId));
  await app.runtime.dispose();
  expect(app.scriptErrors).toEqual([]);
});
test.each([
  ['My SECRET sentence', 'my secret sentence'],
  ['My\n secret\t sentence', 'MY SECRET SENTENCE'],
  ['My\n "secret" sentence', 'my "secret" sentence'],
  ['first abcdefghijklmnopqrst last', 'abcdefghijklmnopqrst'],
])('guard compares strings separately after normalization: %s', async (secret, candidate) => {
  const fixture = await brokerFixture({
    input: z.string().meta(galaxieField({ label: 'private-user' })),
    requests: {
      'echo@1': {
        input: /^[a-z]+$/.test(candidate)
          ? z
              .string()
              .regex(/^[a-z]+$/)
              .max(64)
          : z.enum([candidate]),
        output: z.string(),
        kind: 'read',
      },
    },
    bindings: { 'echo@1': binding({ destination: 'host-server' }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', candidate)).rejects.toMatchObject({
          code: 'denied',
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start(secret);
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('guard catches private property names, but does not register short values or scan local calls', async () => {
  const fixture = await brokerFixture({
    input: z.object({
      long: z.string().meta(galaxieField({ label: 'private-user' })),
      short: z.string().meta(galaxieField({ label: 'private-user' })),
    }),
    requests: {
      'key@1': {
        input: z.record(z.enum(['secret property']), z.number()),
        output: z.unknown(),
        kind: 'read',
      },
      'short@1': {
        input: z
          .string()
          .regex(/^[a-z]+$/)
          .max(64),
        output: z.string(),
        kind: 'read',
      },
      'local@1': { input: z.string(), output: z.string(), kind: 'read' },
    },
    bindings: {
      'key@1': binding({ destination: 'host-server' }),
      'short@1': binding({ destination: 'host-server' }),
      'local@1': binding(),
    },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('key@1', { 'secret property': 1 })).rejects.toMatchObject({
          code: 'denied',
        });
        await expect(capabilities.call('short@1', 'tiny')).resolves.toBe('tiny');
        await expect(capabilities.call('local@1', 'secret property')).resolves.toBe(
          'secret property',
        );
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start({ long: 'secret property', short: 'tiny' });
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});
test('queued dispatch rechecks sticky labels after a preceding output adds private data', async () => {
  const gate = deferred<unknown>();
  const invoke = vi.fn(() => gate.promise);
  const fixture = await brokerFixture({
    input: z.string().meta(galaxieField({ label: 'public' })),
    requests: {
      'echo@1': {
        input: z.string(),
        output: z.string().meta(galaxieField({ label: 'private-user' })),
        kind: 'read',
      },
    },
    bindings: { 'echo@1': binding({ destination: 'host-server', invoke }) },
    scripts: [
      async function* ({ capabilities }) {
        const first = capabilities.call('echo@1', 'first');
        await flush();
        const second = capabilities.call('echo@1', 'second');
        const rejected = expect(second).rejects.toMatchObject({ code: 'denied' });
        await flush();
        gate.resolve('new private output');
        await first;
        await rejected;
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('public');
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('validated private outputs register guard values for later structured calls', async () => {
  const fixture = await brokerFixture({
    input: z.string().meta(galaxieField({ label: 'public' })),
    requests: {
      'read@1': {
        input: z.string(),
        output: z.string().meta(galaxieField({ label: 'private-user' })),
        kind: 'read',
      },
      'send@1': {
        input: z
          .string()
          .regex(/^[a-z-]+$/)
          .max(64),
        output: z.string(),
        kind: 'read',
      },
    },
    bindings: {
      'read@1': binding({ invoke: async () => 'Private-Canary-Handle' }),
      'send@1': binding({ destination: 'host-server' }),
    },
    scripts: [
      async function* ({ capabilities }) {
        await capabilities.call('read@1', 'x');
        await expect(capabilities.call('send@1', 'private-canary-handle')).rejects.toMatchObject({
          code: 'denied',
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  const { runId } = await fixture.instance.start('public');
  await collect(fixture.instance.events(runId));
  await fixture.runtime.dispose();
  expect(fixture.scriptErrors).toEqual([]);
});

test('shared label checks cover every default destination and empty labels', () => {
  for (const destination of destinations) {
    expect(labelsAllow(DEFAULT_DATA_POLICY, [], destination)).toBe(true);
    for (const label of ['public', 'app', 'private-user'] as const) {
      const allowed =
        label === 'public' ||
        (label === 'app' && destination !== 'third-party') ||
        destination === 'in-browser';
      expect(labelsAllow(DEFAULT_DATA_POLICY, [label], destination)).toBe(allowed);
      expect(labelsAllow(DEFAULT_DATA_POLICY, ['public', label], destination)).toBe(allowed);
    }
  }
  expect(inBrowserOnly(DEFAULT_DATA_POLICY, [])).toBe(false);
  expect(inBrowserOnly(DEFAULT_DATA_POLICY, ['app'])).toBe(false);
  expect(inBrowserOnly(DEFAULT_DATA_POLICY, ['public', 'private-user'])).toBe(true);
  expect(inBrowserOnly({ ...DEFAULT_DATA_POLICY, app: { allow: ['in-browser'] } }, ['app'])).toBe(
    true,
  );
});

const privateSentence = 'My private sentence stays here';
const percentEncoded = encodeURIComponent(privateSentence);
test.each([
  ['percent', percentEncoded],
  ['plus', percentEncoded.replaceAll('%20', '+')],
  ['double', encodeURIComponent(percentEncoded)],
  ['malformed', `${percentEncoded}%ZZ`],
  ['double with malformed', `${encodeURIComponent(percentEncoded)}%ZZ`],
])('broker guards encoded private strings and keys: %s', async (_name, candidate) => {
  for (const argument of [{ nested: [{ handle: candidate }] }, { [candidate]: 1 }]) {
    for (const allowed of [false, true]) {
      const invoke = vi.fn(async (_input: unknown) => null);
      const schema =
        'nested' in argument
          ? z.object({ nested: z.array(z.object({ handle: z.enum([candidate]) })) })
          : z.record(z.enum([candidate]), z.number());
      const fixture = await brokerFixture({
        input: z.string().meta(galaxieField({ label: 'private-user' })),
        requests: { 'echo@1': { input: schema, output: z.null(), kind: 'read' } },
        bindings: { 'echo@1': binding({ destination: 'host-server', invoke }) },
        ...(allowed ? { dataPolicy: { 'private-user': { allow: ['host-server'] } } } : {}),
        scripts: [
          async function* ({ capabilities }) {
            const call = capabilities.call('echo@1', argument);
            if (allowed) await expect(call).resolves.toBeNull();
            else {
              await expect(call).rejects.toMatchObject({
                code: 'denied',
                message: 'Policy denied the request.',
              });
              await expect(call).rejects.not.toHaveProperty('cause');
            }
            yield { type: 'output', output: null };
          },
        ],
      });
      try {
        const { runId } = await fixture.instance.start(privateSentence);
        const events = await collect(fixture.instance.events(runId));
        expect(fixture.scriptErrors).toEqual([]);
        expect(invoke).toHaveBeenCalledTimes(allowed ? 1 : 0);
        if (allowed) expect(invoke.mock.calls[0]?.[0]).toEqual(argument);
        expect(fixture.diagnostics).toEqual([]);
        const observation = JSON.stringify([events, fixture.instance.getSnapshot()]);
        expect(observation).not.toContain(privateSentence);
        expect(observation).not.toContain(candidate);
      } finally {
        await fixture.runtime.dispose();
      }
    }
  }
});

test('broker allows an unregistered encoded structured value', async () => {
  const candidate = encodeURIComponent('An unrelated public sentence');
  const invoke = vi.fn(async () => null);
  const fixture = await brokerFixture({
    input: z.string().meta(galaxieField({ label: 'private-user' })),
    requests: {
      'echo@1': {
        input: z.object({ handle: z.enum([candidate]) }),
        output: z.null(),
        kind: 'read',
      },
    },
    bindings: { 'echo@1': binding({ destination: 'host-server', invoke }) },
    scripts: [
      async function* ({ capabilities }) {
        await expect(capabilities.call('echo@1', { handle: candidate })).resolves.toBeNull();
        yield { type: 'output', output: null };
      },
    ],
  });
  try {
    const { runId } = await fixture.instance.start(privateSentence);
    await collect(fixture.instance.events(runId));
    expect(fixture.scriptErrors).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    await fixture.runtime.dispose();
  }
});
