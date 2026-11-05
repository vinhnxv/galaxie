// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  type InteractionId,
  type PendingInteraction,
  type StandardSchema,
  type UiBindings,
  type ViewRevision,
} from '../src/index.js';
import { collect, definition, FakeExecutor, flush } from './fake-executor.js';

const pending: PendingInteraction = {
  interactionId: 'ui-bindings' as InteractionId,
  surfaceId: 'lesson-main',
  viewRevision: 'r1' as ViewRevision,
  component: 'education.Quiz/v1',
  props: {},
};

function bindings(payload: StandardSchema = z.object({ answer: z.boolean() })): UiBindings {
  return {
    components: { 'education.Quiz/v1': { actions: { submit: { payload } } } },
    surfaces: ['lesson-main'],
  };
}

test.each([
  null,
  { components: {}, surfaces: [''] },
  { components: {}, surfaces: [1] },
  { components: {}, surfaces: ['main', 'main'] },
  { components: { 'invalid-component': { actions: {} } }, surfaces: [] },
  {
    components: { 'education.Quiz/v1': { actions: { '': { payload: z.string() } } } },
    surfaces: [],
  },
  { components: { 'education.Quiz/v1': { actions: { submit: { payload: {} } } } }, surfaces: [] },
  {
    components: {
      'education.Quiz/v1': {
        actions: { submit: { payload: { '~standard': { validate: () => ({ value: true }) } } } },
      },
    },
    surfaces: [],
  },
])('create rejects malformed UI bindings without keeping host content: %j', async (ui) => {
  const runtime = createRuntime({ appId: 'ui-validation', executors: [new FakeExecutor()] });
  try {
    await expect(
      runtime.create(definition, { principalScope: 'fixture', agent: {}, ui: ui as UiBindings }),
    ).rejects.toMatchObject({ code: 'invalid' });
  } finally {
    await runtime.dispose();
  }
});

test('create checks required catalog components and surfaces only with UI bindings', async () => {
  const runtime = createRuntime({ appId: 'ui-requirements', executors: [new FakeExecutor()] });
  const required = {
    ...definition,
    ui: { catalog: 'education/v1' as const, components: ['Quiz'], surfaces: ['lesson-main'] },
  };
  try {
    for (const ui of [
      { ...bindings(), components: {} },
      { ...bindings(), surfaces: ['sidebar'] },
    ]) {
      await expect(
        runtime.create(required, { principalScope: 'fixture', agent: {}, ui }),
      ).rejects.toMatchObject({ code: 'unsupported' });
    }
    await expect(
      runtime.create(required, { principalScope: 'fixture', agent: {}, ui: bindings() }),
    ).resolves.toBeDefined();
    await expect(
      runtime.create(required, { principalScope: 'fixture', agent: {} }),
    ).resolves.toBeDefined();
    await expect(
      runtime.create(definition, {
        principalScope: 'fixture',
        agent: {},
        ui: { components: { 'education.Quiz/v1': { actions: {} } }, surfaces: [] },
      }),
    ).resolves.toBeDefined();
  } finally {
    await runtime.dispose();
  }
});

async function waiting(payload?: StandardSchema) {
  const executor = new FakeExecutor([
    [{ type: 'interaction', interaction: pending }],
    [{ type: 'output', output: 'done' }],
  ]);
  Object.assign(executor.features, { resume: true });
  let checkpointReads = 0;
  executor.agent.pending = async () => {
    checkpointReads++;
    return pending;
  };
  const runtime = createRuntime({ appId: 'ui-dispatch', executors: [executor] });
  const instance = await runtime.create(definition, {
    principalScope: 'fixture',
    agent: {},
    ui: bindings(payload),
  });
  await instance.prepare();
  const { runId } = await instance.start('input');
  await flush();
  const event = {
    instanceId: instance.instanceId,
    runId,
    ...pending,
    action: 'submit',
    payload: { answer: true },
  };
  return { instance, runtime, executor, event, checkpointReads: () => checkpointReads };
}

test('dispatch checks the action and payload without recording a rejected submission', async () => {
  const { instance, runtime, executor, event, checkpointReads } = await waiting();
  try {
    const snapshot = instance.getSnapshot();
    for (const invalid of [
      { ...event, action: 'skip' },
      { ...event, action: 'toString' },
      { ...event, payload: { answer: 'payload-canary' } },
    ]) {
      const result = await instance.dispatch(invalid);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'invalid' } });
      expect(JSON.stringify(result)).not.toContain('payload-canary');
      expect(instance.getSnapshot()).toBe(snapshot);
      expect(checkpointReads()).toBe(0);
    }
    await expect(instance.dispatch(event)).resolves.toMatchObject({ status: 'accepted' });
    await expect(instance.dispatch({ ...event, action: 'skip' })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
    await collect(instance.events(event.runId));
    expect(executor.requests[1]?.command).toEqual({
      type: 'resume',
      interactionId: pending.interactionId,
      action: 'submit',
      payload: { answer: true },
    });
  } finally {
    await runtime.dispose();
  }
});

test.each([
  z.string().refine(() => {
    throw new Error('schema-canary');
  }),
  z.string().refine(async () => true),
  {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: async () => {
        throw new Error('async-canary');
      },
    },
  },
])('throwing and asynchronous UI payload schemas reject with fixed errors', async (schema) => {
  const { instance, runtime, event, checkpointReads } = await waiting(schema);
  try {
    const result = await instance.dispatch({ ...event, payload: 'schema-canary' });
    expect(result).toEqual({
      status: 'rejected',
      error: { code: 'invalid', message: 'The request is invalid.' },
    });
    expect(checkpointReads()).toBe(0);
    expect(instance.getSnapshot().run?.pending).toEqual(pending);
  } finally {
    await runtime.dispose();
  }
});

test('UI bindings are copied before host mutation', async () => {
  const executor = new FakeExecutor([[{ type: 'interaction', interaction: pending }]]);
  const runtime = createRuntime({ appId: 'ui-copy', executors: [executor] });
  const ui = {
    components: { 'education.Quiz/v1': { actions: { submit: { payload: z.boolean() } } } },
    surfaces: ['lesson-main'],
  };
  const instance = await runtime.create(definition, { principalScope: 'fixture', agent: {}, ui });
  ui.surfaces.splice(0);
  delete (ui.components as Partial<typeof ui.components>)['education.Quiz/v1'];
  try {
    await instance.prepare();
    await instance.start('input');
    await flush();
    expect(instance.getSnapshot().run?.pending).toEqual(pending);
  } finally {
    await runtime.dispose();
  }
});
