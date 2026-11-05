// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  type DataPolicy,
  galaxieField,
  type InteractionId,
  type PendingInteraction,
  type StandardSchema,
  type ViewRevision,
} from '../src/index.js';
import { binding, collect, definition, FakeExecutor, flush, type Script } from './fake-executor.js';

const pending: PendingInteraction = {
  interactionId: 'writing' as InteractionId,
  surfaceId: 'lesson-main',
  viewRevision: 'r1' as ViewRevision,
  component: 'education.WritingPrompt/v1',
  props: {},
};
const sentence = 'private-learner-sentence';
const privatePayload = z.strictObject({
  sentence: z.string().meta(galaxieField({ label: 'private-user', shape: 'freeText' })),
});

async function fixture(
  schema: StandardSchema | undefined,
  resume: Script = [{ type: 'output', output: null }],
  dataPolicy?: DataPolicy,
  localProvider = true,
) {
  const invoke = vi.fn(async () => true);
  const executor = new FakeExecutor([[{ type: 'interaction', interaction: pending }], resume]);
  Object.assign(executor.features, { resume: true });
  executor.agent.pending = async () => pending;
  const runtime = createRuntime({
    appId: 'ui-labels',
    executors: [executor],
    ...(dataPolicy === undefined ? {} : { dataPolicy }),
  });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.string().meta(galaxieField({ label: 'public' })),
      models: { review: { modality: 'text' } },
      capabilities: {
        required: {
          'send@1': {
            kind: 'read',
            input: z
              .string()
              .regex(/^[a-z-]+$/)
              .max(64),
            output: z.boolean(),
          },
        },
      },
    },
    {
      principalScope: 'learner',
      agent: {},
      bindings: { 'send@1': { ...binding({ destination: 'host-server' }), invoke } },
      models: {
        providers: {
          local: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
          remote: {
            destination: 'host-server',
            modality: 'text',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          review: {
            providers: localProvider ? ['remote', 'local'] : ['remote'],
            allow: ['host-server', 'in-browser'],
            maxTokens: 10,
          },
        },
      },
      ...(schema === undefined
        ? {}
        : {
            ui: {
              components: {
                'education.WritingPrompt/v1': { actions: { submit: { payload: schema } } },
              },
              surfaces: ['lesson-main'],
            },
          }),
    },
  );
  await instance.prepare();
  const { runId } = await instance.start('public lesson');
  await flush();
  const event = {
    instanceId: instance.instanceId,
    runId,
    ...pending,
    action: 'submit',
    payload: { sentence },
  };
  return { instance, runtime, event, invoke };
}

test('accepted bound text labels routing before resume and preserves the existing label', async () => {
  let provider: string | undefined;
  const { instance, runtime, event } = await fixture(privatePayload, async function* ({ models }) {
    const call = await models.begin('review');
    provider = call.providerId;
    call.end();
    yield { type: 'output', output: null };
  });
  try {
    expect(instance.getSnapshot().run?.labels).toEqual(['public']);
    expect(await instance.dispatch(event)).toMatchObject({ status: 'accepted' });
    await collect(instance.events(event.runId));
    expect(instance.getSnapshot().run?.labels).toEqual(['private-user', 'public']);
    expect(provider).toBe('local');
  } finally {
    await runtime.dispose();
  }
});

test('private submission values reach the verbatim guard for structured capability arguments', async () => {
  let denied = false;
  const { instance, runtime, event, invoke } = await fixture(
    privatePayload,
    async function* ({ capabilities }) {
      await expect(capabilities.call('send@1', sentence)).rejects.toMatchObject({ code: 'denied' });
      denied = true;
      yield { type: 'output', output: null };
    },
  );
  try {
    await instance.dispatch(event);
    await collect(instance.events(event.runId));
    expect(denied).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

test('a remote-only routed role is denied in the resumed segment', async () => {
  let denied = false;
  const { instance, runtime, event } = await fixture(
    privatePayload,
    async function* ({ models }) {
      await expect(models.begin('review')).rejects.toMatchObject({ code: 'denied' });
      denied = true;
      yield { type: 'output', output: null };
    },
    undefined,
    false,
  );
  try {
    await instance.dispatch(event);
    await collect(instance.events(event.runId));
    expect(denied).toBe(true);
  } finally {
    await runtime.dispose();
  }
});

const opaque: StandardSchema = {
  '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value }) },
};
const unreadable = z.object({ sentence: z.string() }).meta({ unsupported: true });
test.each([
  ['opaque', opaque],
  ['rejected annotations', unreadable],
] as const)(
  'fallback private values block structured outbound arguments: %s',
  async (_name, schema) => {
    let error: unknown;
    const { instance, runtime, event, invoke } = await fixture(
      schema,
      async function* ({ capabilities }) {
        try {
          await capabilities.call('send@1', sentence);
        } catch (caught) {
          error = caught;
        }
        yield { type: 'output', output: null };
      },
    );
    try {
      expect(await instance.dispatch(event)).toMatchObject({ status: 'accepted' });
      await collect(instance.events(event.runId));
      expect(instance.getSnapshot().run?.labels).toContain('private-user');
      expect(error).toMatchObject({ code: 'denied' });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  },
);

test.each([
  [z.strictObject({ sentence: z.string() }), { sentence }, ['app', 'public']],
  [opaque, { sentence }, ['private-user', 'public']],
  [opaque, { count: 1 }, ['public']],
  [unreadable, { sentence }, ['private-user', 'public']],
  [undefined, { sentence }, ['public']],
] as const)(
  'accepted payload labels follow its trusted schema: %j',
  async (schema, payload, labels) => {
    const { instance, runtime, event } = await fixture(schema);
    try {
      expect(await instance.dispatch({ ...event, payload })).toMatchObject({ status: 'accepted' });
      await collect(instance.events(event.runId));
      expect(instance.getSnapshot().run?.labels).toEqual(labels);
    } finally {
      await runtime.dispose();
    }
  },
);

test('invalid, stale and duplicate dispatches add no labels', async () => {
  const { instance, runtime, event } = await fixture(privatePayload);
  try {
    for (const invalid of [
      { ...event, payload: { sentence: 1 } },
      { ...event, interactionId: 'stale' as InteractionId },
    ]) {
      expect(await instance.dispatch(invalid)).toMatchObject({ status: 'rejected' });
      expect(instance.getSnapshot().run?.labels).toEqual(['public']);
    }
    await instance.dispatch(event);
    const labels = instance.getSnapshot().run?.labels;
    expect(await instance.dispatch(event)).toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
    expect(instance.getSnapshot().run?.labels).toEqual(labels);
  } finally {
    await runtime.dispose();
  }
});
