// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createLangGraphAdapter,
  requestInteraction,
  requestSurface,
} from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  materializeSurface,
  type PendingInteraction,
  type RecoveryStore,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import {
  A2UI_SPEC_REVISION,
  A2UI_SPEC_VERSION,
  type Catalog,
  type MaterializedSurface,
  type SyncSchema,
} from '@galaxie-ai/ui-protocol';
import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import type { ConformanceGraph } from './support/transcript.js';

function sync(schema: z.ZodType): SyncSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'surface-test',
      validate(value: unknown) {
        const result = schema.safeParse(value);
        return result.success ? { value: result.data } : { issues: [] };
      },
    },
  };
}

const catalog: Catalog = {
  id: 'education/v1',
  components: {
    Quiz: {
      bindable: ['answer'],
      children: ['children'],
      props: sync(z.object({ answer: z.string(), children: z.array(z.string()) }).strict()),
    },
    Text: { props: sync(z.object({ text: z.string() }).strict()) },
  },
};
const context = {
  binding: { region: 'main', a2uiSurfaceId: 'lesson', catalogId: catalog.id },
  catalog,
  limits: { payloadBytes: 1_048_576, components: 50 },
  isAllowedUrl: () => false,
};
function surface(): MaterializedSurface {
  return materializeSurface({
    ...context,
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'lesson',
          dataModel: { answer: '', fixed: 1 },
          components: [
            { id: 'root', component: 'Quiz', answer: { '@path': '/answer' }, children: ['text'] },
            { id: 'text', component: 'Text', text: 'Choose' },
          ],
        },
      },
    ],
  });
}
const runtimes: Array<{ dispose(): Promise<void> }> = [];
const savers: IndexedDBSaver[] = [];
const databases = new Set<string>();
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const saver of savers.splice(0)) saver.close();
  for (const name of databases)
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase(name);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error('Surface database cleanup was blocked.'));
    });
  databases.clear();
});
async function open(databaseName: string): Promise<IndexedDBSaver> {
  databases.add(databaseName);
  const saver = await IndexedDBSaver.open({
    databaseName,
    appId: 'surface-conformance',
    principalScope: 'user',
  });
  savers.push(saver);
  return saver;
}
async function storage(): Promise<{
  readonly saver: BaseCheckpointSaver;
  readonly recovery: RecoveryStore;
  readonly reopen: () => Promise<{
    readonly saver: BaseCheckpointSaver;
    readonly recovery: RecoveryStore;
  }>;
}> {
  if (typeof indexedDB === 'undefined') {
    const saver = new MemorySaver();
    const recovery = new MemoryRecoveryStore();
    return { saver, recovery, reopen: async () => ({ saver, recovery }) };
  }
  const name = `galaxie-surfaces-${crypto.randomUUID()}`;
  const saver = await open(name);
  return {
    saver,
    recovery: saver.recovery,
    reopen: async () => {
      saver.close();
      const reopened = await open(name);
      return { saver: reopened, recovery: reopened.recovery };
    },
  };
}
async function fixture(
  saver: BaseCheckpointSaver,
  recovery: RecoveryStore,
  options: {
    readonly sessionId?: SessionId;
    readonly legacy?: boolean;
    readonly record?: MaterializedSurface;
  } = {},
) {
  const runtime = createRuntime({
    appId: 'surface-conformance',
    executors: [createLangGraphAdapter()],
  });
  runtimes.push(runtime);
  const initial = options.record ?? surface();
  let graph: ConformanceGraph | undefined;
  const instance = await runtime.create(
    {
      id: 'conformance/surface',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
    },
    {
      principalScope: 'user',
      recovery,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ui: {
        catalogs: { [catalog.id]: catalog },
        surfaces: ['main'],
        components: {
          'education.Quiz/v1': {
            actions: { submit: { payload: z.object({ answers: z.array(z.string()) }).strict() } },
          },
          'education.Text/v1': { actions: { continue: { payload: z.object({}).strict() } } },
        },
      },
      services: { checkpointer: saver, chatModels: {} },
      agent: (host) => {
        const state = Annotation.Root({ result: Annotation<unknown> });
        graph = new StateGraph(state)
          .addNode('ask', async (_state, config) => {
            await Promise.resolve();
            const result = options.legacy
              ? requestInteraction(
                  {
                    surfaceId: 'main',
                    viewRevision: 'legacy-token',
                    component: 'education.Quiz/v1',
                    props: { answer: '' },
                  },
                  config,
                )
              : requestSurface(initial, config);
            return { result };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() })
          .withConfig({ durability: 'sync' });
        return graph;
      },
    },
  );
  await instance.prepare();
  if (graph === undefined) throw new Error('The surface graph was not prepared.');
  return { runtime, instance, graph };
}
function event(
  instance: AgentInstance<unknown, unknown>,
  componentId = 'root',
): UserInteractionEvent {
  const run = instance.getSnapshot().run;
  const pending = run?.pending;
  if (run === undefined || pending === undefined)
    throw new Error('The test interaction is missing.');
  return {
    instanceId: instance.instanceId,
    runId: run.runId,
    interactionId: pending.interactionId,
    surfaceId: pending.surfaceId,
    viewRevision: pending.viewRevision,
    action: 'submit',
    payload: { answers: ['yes'] },
    ...(pending.surface === undefined
      ? {}
      : {
          surfaceAction: {
            revision: pending.surface.revision,
            componentId,
            dataModel: pending.surface.dataModel,
          },
        }),
  };
}
async function paused(instance: AgentInstance<unknown, unknown>): Promise<PendingInteraction> {
  await instance.start({});
  await vi.waitFor(() => expect(instance.getSnapshot().run?.status).toBe('waiting_input'));
  const pending = instance.getSnapshot().run?.pending;
  if (pending === undefined) throw new Error('The test interaction is missing.');
  return pending;
}

test('reload restores the same materialized checkpoint and dispatches against its committed revision', async () => {
  const store = await storage();
  const first = await fixture(store.saver, store.recovery);
  const before = await paused(first.instance);
  const oldEvent = event(first.instance);
  const state = await first.graph.getState({
    configurable: { thread_id: first.instance.sessionId },
  });
  const saved = state.tasks.flatMap((task) => task.interrupts)[0]?.value;
  expect(saved).toEqual(surface());
  expect(saved).toMatchObject({ specVersion: A2UI_SPEC_VERSION, specRevision: A2UI_SPEC_REVISION });
  expect(saved).not.toHaveProperty('labels');
  expect(saved).not.toHaveProperty('viewRevision');
  await first.runtime.dispose();
  const reopened = await store.reopen();
  const restored = await fixture(reopened.saver, reopened.recovery, {
    sessionId: first.instance.sessionId,
  });
  await restored.instance.restore();
  const after = restored.instance.getSnapshot().run?.pending;
  expect(after?.surface?.components).toEqual(before.surface?.components);
  expect(after?.surface?.dataModel).toEqual(before.surface?.dataModel);
  expect(after?.surface?.revision).toBe(before.surface?.revision);
  expect(after?.viewRevision).toBe(before.viewRevision);
  expect(after?.interactionId).toBe(before.interactionId);
  expect(after?.surface?.labels).toEqual(['app', 'private-user', 'public']);
  expect(await restored.instance.dispatch(oldEvent)).toMatchObject({ error: { code: 'stale' } });
  const action = event(restored.instance);
  expect(
    await restored.instance.dispatch({
      ...action,
      surfaceAction: {
        ...(action.surfaceAction as NonNullable<UserInteractionEvent['surfaceAction']>),
        revision: 2,
      },
    }),
  ).toMatchObject({ error: { code: 'stale' } });
  expect(
    await restored.instance.dispatch({
      ...action,
      viewRevision: 'wrong' as UserInteractionEvent['viewRevision'],
    }),
  ).toMatchObject({ error: { code: 'stale' } });
  expect(
    await restored.instance.dispatch({
      ...action,
      surfaceAction: undefined,
    } as unknown as UserInteractionEvent),
  ).toMatchObject({ error: { code: 'invalid' } });
  expect(await restored.instance.dispatch(action)).toMatchObject({ status: 'accepted' });
  expect(await restored.instance.dispatch(action)).toMatchObject({ error: { code: 'duplicate' } });
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  const finished = await restored.graph.getState({
    configurable: { thread_id: restored.instance.sessionId },
  });
  expect(finished.values).toEqual({ result: { action: 'submit', payload: { answers: ['yes'] } } });
});

test('accepted surface replay validates any registered component action without a stored component ID', async () => {
  const store = await storage();
  const first = await fixture(store.saver, store.recovery);
  const pending = await paused(first.instance);
  await store.recovery.acceptSubmission(first.instance.sessionId, {
    interactionId: pending.interactionId,
    action: 'continue',
    payload: {},
  });
  await first.runtime.dispose();
  const reopened = await store.reopen();
  const restored = await fixture(reopened.saver, reopened.recovery, {
    sessionId: first.instance.sessionId,
  });
  await restored.instance.restore();
  await vi.waitFor(() => expect(restored.instance.getSnapshot().run?.status).toBe('succeeded'));
  const state = await restored.graph.getState({
    configurable: { thread_id: restored.instance.sessionId },
  });
  expect(state.values).toEqual({ result: { action: 'continue', payload: {} } });
});

test('unknown stored pins are refused on restore without publication', async () => {
  const store = await storage();
  const old = { ...surface(), specRevision: 'unknown-spec' };
  const first = await fixture(store.saver, store.recovery, { record: old });
  await first.instance.start({});
  await vi.waitFor(() => expect(first.instance.getSnapshot().run?.error?.code).toBe('unsupported'));
  await first.runtime.dispose();
  const reopened = await store.reopen();
  const restored = await fixture(reopened.saver, reopened.recovery, {
    sessionId: first.instance.sessionId,
  });
  await expect(restored.instance.restore()).rejects.toMatchObject({ code: 'unsupported' });
  expect(restored.instance.getSnapshot().run).toBeUndefined();
});

test('the four-field requestInteraction checkpoint and domain submission remain unchanged', async () => {
  const store = await storage();
  const first = await fixture(store.saver, store.recovery, { legacy: true });
  const pending = await paused(first.instance);
  expect(pending).not.toHaveProperty('surface');
  expect(pending).toMatchObject({
    surfaceId: 'main',
    viewRevision: 'legacy-token',
    props: { answer: '' },
  });
  const action = event(first.instance);
  expect(
    await first.instance.dispatch({
      ...action,
      surfaceAction: { revision: 1, componentId: 'root', dataModel: {} },
    }),
  ).toMatchObject({ error: { code: 'invalid' } });
  expect(await first.instance.dispatch(action)).toMatchObject({ status: 'accepted' });
  await vi.waitFor(() => expect(first.instance.getSnapshot().run?.status).toBe('succeeded'));
});

test('accepted replay rejects a domain payload unsupported by every surface component', async () => {
  const store = await storage();
  const first = await fixture(store.saver, store.recovery);
  const pending = await paused(first.instance);
  await store.recovery.acceptSubmission(first.instance.sessionId, {
    interactionId: pending.interactionId,
    action: 'submit',
    payload: { answers: false },
  });
  await first.runtime.dispose();
  const reopened = await store.reopen();
  const restored = await fixture(reopened.saver, reopened.recovery, {
    sessionId: first.instance.sessionId,
  });
  await expect(restored.instance.restore()).rejects.toMatchObject({
    code: 'invalid',
    message: 'The request is invalid.',
  });
  expect(restored.instance.getSnapshot().run).toBeUndefined();
});

test.each([
  null,
  [],
  { format: 'galaxie.surface/1' },
  { ...surface(), dataModel: { value: new Date() } },
])('requestSurface refuses malformed records with fixed text before interrupting', (value) => {
  expect(() => requestSurface(value, {})).toThrow('The interaction request is invalid.');
});
