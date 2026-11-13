// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../packages/adapter-adk/test/support/adk-env.js';
import {
  type AgentInstance,
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RecoveryStore,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import { LlmAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  type AdkAgent,
  createAdkAdapter,
  defineAdkEntry,
} from '../../packages/adapter-adk/src/index.js';
import { FakeChatModel, type Reply } from '../../packages/adapter-adk/test/support/fixtures.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';
import { waitForRunStatus } from './support/run-status.js';

/** Node has no IndexedDB, so its lane keeps the byte records and the journal in memory. */
const durable = typeof indexedDB !== 'undefined';

interface Store {
  readonly checkpoints: { request(value: unknown): Promise<unknown> };
  readonly recovery: RecoveryStore;
  readonly saver?: IndexedDBSaver;
  close(): void;
}

const databases: string[] = [];
const closers: Array<() => void> = [];
const runtimes: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const close of closers.splice(0)) close();
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database cleanup was blocked.'));
    });
  }
});

/** A store that survives dispose, as the page's storage survives a reload. */
function shared(name: string): { open(): Promise<Store> } {
  const bytes = new MemoryByteCheckpoints();
  const journal = new MemoryRecoveryStore();
  return {
    async open() {
      if (!durable) return { checkpoints: bytes, recovery: journal, close() {} };
      if (!databases.includes(name)) databases.push(name);
      const saver = await IndexedDBSaver.open({
        databaseName: name,
        appId: 'adk-restore',
        principalScope: 'user',
      });
      closers.push(() => saver.close());
      return {
        checkpoints: saver.byteRecords,
        recovery: saver.recovery,
        saver,
        close: () => saver.close(),
      };
    },
  };
}

const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling', 'structured-output'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};

const definition = defineAgentDefinition({
  id: 'conformance/adk-restore',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.save@1': {
        kind: 'write',
        input: z.object({ q: z.string() }),
        output: z.object({ saved: z.string() }),
      },
    },
  },
});

const secret = 'canary-restored-prompt-7c1f';
const save = {
  description: 'Save a note.',
  parameters: z.object({ q: z.string() }),
  requireConfirmation: true,
};

const agent: AdkAgent = (host) =>
  defineAdkEntry({
    agent: new LlmAgent({
      name: 'agent',
      model: host.adk.llm('agent'),
      instruction: 'Answer briefly.',
      tools: [host.adk.capabilityTool('docs.save@1', save)],
    }),
    interaction: (requests) => ({
      surfaceId: 'main',
      viewRevision: 'r1',
      component: 'conformance.Approval/v1',
      props: { count: requests.length },
    }),
  });

/** Saves once while no tool message exists, then answers. */
const saving: Reply = (seen) =>
  seen.messages.some((message) => message.type === 'tool')
    ? new AIMessage({ content: 'finished' })
    : new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_0', name: 'docs_save_1', args: { q: 'note' } }],
      });

interface Life {
  readonly runtime: ReturnType<typeof createRuntime>;
  readonly instance: AgentInstance<unknown, unknown>;
  readonly model: FakeChatModel;
  readonly writes: { q: string }[];
  readonly sessionId: SessionId;
}

async function life(
  store: Store,
  reply: Reply,
  options: { sessionId?: SessionId; recovery?: boolean; factory?: AdkAgent } = {},
): Promise<Life> {
  const model = new FakeChatModel(reply);
  const writes: { q: string }[] = [];
  const runtime = createRuntime({
    appId: 'adk-restore',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 8, toolCalls: 10, tokens: 5000 },
  });
  runtimes.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.recovery === false ? {} : { recovery: store.recovery }),
    // The tool helper offers a write only behind a configured host confirmation.
    confirmations: { capabilities: ['docs.save@1'], policyRevision: () => 'adk-restore-v1' },
    agent: options.factory ?? agent,
    services: { chatModels: { mock: model }, checkpoints: store.checkpoints },
    bindings: {
      'docs.save@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'confirm',
        retry: 'none',
        async invoke(input: { q: string }) {
          writes.push(input);
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  // These tests exercise the pause and the restore, so the broker's confirmation is approved
  // as soon as it appears.
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      instance.respond(pending.id, 'approve');
  }, 5);
  closers.push(() => clearInterval(timer));
  return { runtime, instance, model, writes, sessionId: instance.sessionId };
}

async function approval(life: Life): Promise<UserInteractionEvent> {
  await waitForRunStatus(life.instance, 'waiting_input');
  const run = life.instance.getSnapshot().run;
  if (run?.pending === undefined) throw new Error('The run did not pause.');
  return {
    instanceId: life.instance.instanceId,
    runId: run.runId,
    ...run.pending,
    action: 'approve',
    payload: { indexes: [0] },
  };
}

test('a pause survives a reload and resumes to completion with its integrity stamps intact', async () => {
  const source = shared('adk-restore-reload');
  const first = await life(await source.open(), saving);
  await first.instance.start({ prompt: secret });
  const submitted = await approval(first);
  await first.runtime.dispose();
  expect(first.writes).toHaveLength(0);

  const second = await life(await source.open(), saving, { sessionId: first.sessionId });
  expect(await second.instance.restore()).toBeDefined();
  const restored = await approval(second);
  expect(restored.interactionId).toBe(submitted.interactionId);
  expect(restored.surfaceId).toBe('main');
  expect((await second.instance.dispatch(restored)).status).toBe('accepted');
  await waitForRunStatus(second.instance, 'succeeded');
  expect(second.writes).toEqual([{ q: 'note' }]);
  // The restored conversation was registered as private before the resumed run replayed it.
  expect(second.instance.getSnapshot().run?.labels).toContain('private-user');
  // The model saw the restored prompt and the tool result in one history.
  const texts = JSON.stringify(
    second.model.seen.at(-1)?.messages.map((message) => message.content),
  );
  expect(texts).toContain(secret);

  // A third lifetime finds a completed conversation: nothing is pending.
  await second.runtime.dispose();
  const third = await life(await source.open(), saving, { sessionId: first.sessionId });
  expect(await third.instance.restore()).toBeUndefined();
});

test('a write approved before a crash replays its receipt after the restore', async () => {
  const source = shared('adk-restore-receipt');
  let calls = 0;
  const crashing: Reply = (seen) => {
    if (seen.messages.some((message) => message.type === 'tool')) {
      calls += 1;
      throw new Error('The simulated page closed.');
    }
    return saving(seen, 0);
  };
  const first = await life(await source.open(), crashing);
  await first.instance.start({ prompt: 'go' });
  await first.instance.dispatch(await approval(first));
  await waitForRunStatus(first.instance, 'failed');
  expect(calls).toBeGreaterThan(0);
  expect(first.writes).toHaveLength(1);
  await first.runtime.dispose();

  const second = await life(await source.open(), saving, { sessionId: first.sessionId });
  expect(await second.instance.restore()).toBeDefined();
  await waitForRunStatus(second.instance, 'succeeded');
  expect(second.writes).toHaveLength(0);
});

test('a failed run writes nothing, so a restore returns to the last stored pause', async () => {
  const source = shared('adk-restore-failed');
  const failing: Reply = (seen) => {
    if (seen.messages.some((message) => message.type === 'tool')) throw new Error('boom');
    return saving(seen, 0);
  };
  const first = await life(await source.open(), failing);
  await first.instance.start({ prompt: 'go' });
  const submitted = await approval(first);
  await first.instance.dispatch(submitted);
  await waitForRunStatus(first.instance, 'failed');
  await first.runtime.dispose();
  const second = await life(await source.open(), saving, {
    sessionId: first.sessionId,
    recovery: false,
  });
  await second.instance.restore();
  expect((await approval(second)).interactionId).toBe(submitted.interactionId);
});

test('a session saved by another executor is refused', async () => {
  const source = shared('adk-restore-other');
  const store = await source.open();
  const foreign = crypto.randomUUID() as SessionId;
  await store.recovery.recordSession(foreign, {
    executorId: 'langgraph-js',
    agentId: definition.id,
    agentVersion: definition.version,
  });
  const other = await life(store, saving, { sessionId: foreign });
  await expect(other.instance.restore()).rejects.toThrow(
    'The saved session uses a different executor.',
  );
});

test.skipIf(durable)('a tampered stored call fails before any tool runs', async () => {
  const bytes = new MemoryByteCheckpoints();
  const store: Store = { checkpoints: bytes, recovery: new MemoryRecoveryStore(), close() {} };
  const first = await life(store, saving);
  await first.instance.start({ prompt: 'go' });
  await approval(first);
  await first.runtime.dispose();
  const [row] = [...bytes.rows.values()];
  if (row === undefined) throw new Error('No record was stored.');
  const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
  for (const event of body.events)
    for (const part of event.content?.parts ?? [])
      if (part.functionCall?.name === 'docs_save_1') part.functionCall.args = { q: 'forged' };
  // The pause block is forged to match, so only ADK's stamp check can catch the change.
  for (const call of body.pause.calls) call.request.args = { q: 'forged' };
  bytes.rows.set(JSON.stringify([first.sessionId, '', row.id]), {
    ...row,
    checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(JSON.stringify(body)) },
  });
  const second = await life(store, saving, { sessionId: first.sessionId });
  await second.instance.restore();
  await second.instance.dispatch(await approval(second));
  await waitForRunStatus(second.instance, 'failed');
  expect(second.writes).toHaveLength(0);
  expect(second.instance.getSnapshot().run?.error?.code).toBe('invalid');
});

test.skipIf(durable)('a record spliced from another session is unrecoverable', async () => {
  const bytes = new MemoryByteCheckpoints();
  const store: Store = { checkpoints: bytes, recovery: new MemoryRecoveryStore(), close() {} };
  const first = await life(store, saving);
  await first.instance.start({ prompt: 'go' });
  await approval(first);
  await first.runtime.dispose();
  const spliced = crypto.randomUUID() as SessionId;
  const [row] = [...bytes.rows.values()];
  if (row === undefined) throw new Error('No record was stored.');
  bytes.rows.set(JSON.stringify([spliced, '', row.id]), { ...row, sessionId: spliced });
  await store.recovery.recordSession(spliced, {
    executorId: 'adk-js',
    agentId: definition.id,
    agentVersion: definition.version,
  });
  const second = await life(store, saving, { sessionId: spliced });
  await expect(second.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
});

test.skipIf(durable)(
  'a corrupt record is unrecoverable and leaves other sessions readable',
  async () => {
    const bytes = new MemoryByteCheckpoints();
    const store: Store = { checkpoints: bytes, recovery: new MemoryRecoveryStore(), close() {} };
    const first = await life(store, saving);
    await first.instance.start({ prompt: 'go' });
    await approval(first);
    await first.runtime.dispose();
    const other = await life(store, saving);
    await other.instance.start({ prompt: 'go' });
    await approval(other);
    await other.runtime.dispose();
    for (const row of bytes.rows.values())
      if (row.sessionId === first.sessionId)
        (row as { checkpoint: unknown }).checkpoint = {
          ...row.checkpoint,
          bytes: new TextEncoder().encode('{"v":1'),
        };
    const broken = await life(store, saving, { sessionId: first.sessionId });
    await expect(broken.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
    const fine = await life(store, saving, { sessionId: other.sessionId });
    expect(await fine.instance.restore()).toBeDefined();
  },
);

test.skipIf(!durable)(
  'an export names the executor and never includes the integrity key',
  async () => {
    const source = shared('adk-restore-export');
    const store = await source.open();
    const first = await life(store, saving);
    await first.instance.start({ prompt: secret });
    await approval(first);
    const key = (await store.checkpoints.request({
      op: 'get',
      executor: 'adk-js',
      sessionId: first.sessionId,
      namespace: '',
    })) as { metadata: { bytes: Uint8Array } };
    const state = JSON.parse(new TextDecoder().decode(key.metadata.bytes)) as { key: string };
    const metadataOnly = await store.saver?.exportSession(first.sessionId);
    const personal = await store.saver?.exportSession(first.sessionId, { personalContent: true });
    expect(JSON.stringify(metadataOnly)).not.toContain(secret);
    expect(metadataOnly?.metadata.pendingInteractionCount).toBe(1);
    expect(personal?.checkpoints?.[0]?.executor).toBe('adk-js');
    expect(JSON.stringify(personal)).not.toContain(state.key);
    expect(JSON.stringify(personal)).toContain('adk.session');
  },
);

test('a run without checkpoints keeps working in memory', async () => {
  const model = new FakeChatModel(() => new AIMessage({ content: 'hello' }));
  const runtime = createRuntime({
    appId: 'adk-restore',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 8, toolCalls: 10, tokens: 5000 },
  });
  runtimes.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: ((host) =>
      new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'Answer briefly.',
      })) as AdkAgent,
    services: { chatModels: { mock: model } },
    bindings: {
      'docs.save@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { q: string }) {
          return { saved: input.q };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  await instance.start({ prompt: 'hi' });
  await waitForRunStatus(instance, 'succeeded');
});

test.skipIf(durable)(
  'a pause whose arguments differ from the stamped call is unrecoverable',
  async () => {
    const bytes = new MemoryByteCheckpoints();
    const store: Store = { checkpoints: bytes, recovery: new MemoryRecoveryStore(), close() {} };
    const first = await life(store, saving);
    await first.instance.start({ prompt: 'go' });
    await approval(first);
    await first.runtime.dispose();
    const [row] = [...bytes.rows.values()];
    if (row === undefined) throw new Error('No record was stored.');
    const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
    for (const call of body.pause.calls) call.request.args = { q: 'forged' };
    bytes.rows.set(JSON.stringify([first.sessionId, '', row.id]), {
      ...row,
      checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(JSON.stringify(body)) },
    });
    const second = await life(store, saving, { sessionId: first.sessionId });
    await expect(second.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
  },
);

test('a confirmation raised inside the first sub-agent survives a reload and resumes in place', async () => {
  const source = shared('adk-restore-child');
  const nested: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new SequentialAgent({
        name: 'flow',
        subAgents: [
          new LlmAgent({
            name: 'first',
            model: host.adk.llm('agent'),
            instruction: 'role=first;',
            tools: [host.adk.capabilityTool('docs.save@1', save)],
          }),
          new LlmAgent({
            name: 'second',
            model: host.adk.llm('agent'),
            instruction: 'role=second;',
          }),
        ],
      }),
      interaction: (requests) => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'conformance.Approval/v1',
        props: { count: requests.length },
      }),
    });
  const script: Reply = (seen) => {
    const system = JSON.stringify(seen.messages[0]?.content ?? '');
    return system.includes('role=second;') ? new AIMessage({ content: 'two' }) : saving(seen, 0);
  };
  const first = await life(await source.open(), script, { factory: nested });
  await first.instance.start({ prompt: 'go' });
  const submitted = await approval(first);
  await first.runtime.dispose();
  expect(first.writes).toHaveLength(0);

  const second = await life(await source.open(), script, {
    sessionId: first.sessionId,
    factory: nested,
  });
  expect(await second.instance.restore()).toBeDefined();
  const restored = await approval(second);
  expect(restored.interactionId).toBe(submitted.interactionId);
  await second.instance.dispatch(restored);
  await waitForRunStatus(second.instance, 'succeeded');
  expect(second.writes).toEqual([{ q: 'note' }]);
  const systems = second.model.seen.map((call) => JSON.stringify(call.messages[0]?.content));
  expect(systems.at(-1)).toContain('role=second;');
  // The paused first child asked the model once more to finish; nothing earlier ran again.
  expect(systems.filter((system) => system.includes('role=first;'))).toHaveLength(1);
});

test('a confirmation raised by a sub-agent reached by transfer survives a reload and resumes in place', async () => {
  const source = shared('adk-restore-transfer');
  const transfer: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new LlmAgent({
        name: 'parent',
        model: host.adk.llm('agent'),
        instruction: 'role=parent;',
        subAgents: [
          new LlmAgent({
            name: 'child',
            model: host.adk.llm('agent'),
            instruction: 'role=child;',
            tools: [host.adk.capabilityTool('docs.save@1', save)],
          }),
        ],
      }),
      interaction: (requests) => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'conformance.Approval/v1',
        props: { count: requests.length },
      }),
    });
  const script: Reply = (seen) => {
    const system = JSON.stringify(seen.messages[0]?.content ?? '');
    if (system.includes('role=parent;'))
      return seen.messages.some((message) => message.type === 'tool')
        ? new AIMessage({ content: 'handed over' })
        : new AIMessage({
            content: '',
            tool_calls: [
              { id: 'call_t', name: 'transfer_to_agent', args: { agent_name: 'child' } },
            ],
          });
    return saving(seen, 0);
  };
  const first = await life(await source.open(), script, { factory: transfer });
  await first.instance.start({ prompt: 'go' });
  const submitted = await approval(first);
  await first.runtime.dispose();
  expect(first.writes).toHaveLength(0);

  const second = await life(await source.open(), script, {
    sessionId: first.sessionId,
    factory: transfer,
  });
  expect(await second.instance.restore()).toBeDefined();
  const restored = await approval(second);
  expect(restored.interactionId).toBe(submitted.interactionId);
  await second.instance.dispatch(restored);
  await waitForRunStatus(second.instance, 'succeeded');
  expect(second.writes).toEqual([{ q: 'note' }]);
  // The parent did not decide again: only the paused child asked the model after the resume.
  const systems = second.model.seen.map((call) => JSON.stringify(call.messages[0]?.content));
  expect(systems.some((system) => system.includes('role=parent;'))).toBe(false);
});

test('a long-running pause reloads with the same interaction and does not repeat its write', async () => {
  const source = shared('adk-restore-long-running');
  const longRunning: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'Answer briefly.',
        tools: [
          host.adk.capabilityTool('docs.save@1', {
            description: save.description,
            parameters: save.parameters,
            longRunning: true,
          }),
        ],
      }),
      interaction: (requests) => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'conformance.Approval/v1',
        props: { count: requests.length },
      }),
      resume: () => [{ response: { saved: 'external' } }],
    });
  const first = await life(await source.open(), saving, { factory: longRunning });
  await first.instance.start({ prompt: 'go' });
  const submitted = await approval(first);
  expect(first.writes).toEqual([{ q: 'note' }]);
  await first.runtime.dispose();

  const second = await life(await source.open(), saving, {
    sessionId: first.sessionId,
    factory: longRunning,
  });
  expect(await second.instance.restore()).toBeDefined();
  const restored = await approval(second);
  expect(restored.interactionId).toBe(submitted.interactionId);
  expect(second.model.seen).toEqual([]);
  expect(second.writes).toEqual([]);
  expect((await second.instance.dispatch(restored)).status).toBe('accepted');
  await waitForRunStatus(second.instance, 'succeeded');
  expect(second.writes).toEqual([]);
  expect(JSON.stringify(second.model.seen.at(-1)?.messages)).toContain('external');
});

test('moving a paused author to a middle child rejects restore before anything runs', async () => {
  const source = shared('adk-restore-changed-tree');
  const store = await source.open();
  const first = await life(store, saving);
  await first.instance.start({ prompt: 'go' });
  await approval(first);
  const request = { op: 'get', executor: 'adk-js', sessionId: first.sessionId, namespace: '' };
  const before = structuredClone(await store.checkpoints.request(request));
  await first.runtime.dispose();
  const changed: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new SequentialAgent({
        name: 'flow',
        subAgents: ['earlier', 'agent', 'later'].map(
          (name) =>
            new LlmAgent({
              name,
              model: host.adk.llm('agent'),
              instruction: 'Answer briefly.',
              tools: [host.adk.capabilityTool('docs.save@1', save)],
            }),
        ),
      }),
      interaction: () => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'conformance.Approval/v1',
        props: { count: 1 },
      }),
    });
  const second = await life(store, saving, { sessionId: first.sessionId, factory: changed });
  await expect(second.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
  expect(second.model.seen).toEqual([]);
  expect(second.writes).toEqual([]);
  expect(second.instance.getSnapshot().run?.pending).toBeUndefined();
  expect(await store.checkpoints.request(request)).toEqual(before);
});

test.skipIf(durable)(
  'workflow-state rejection repeats without changing rows or other sessions',
  async () => {
    const bytes = new MemoryByteCheckpoints();
    const store: Store = { checkpoints: bytes, recovery: new MemoryRecoveryStore(), close() {} };
    const first = await life(store, saving);
    await first.instance.start({ prompt: 'go' });
    await approval(first);
    await first.runtime.dispose();
    const other = await life(store, saving);
    await other.instance.start({ prompt: 'go' });
    const untouched = await approval(other);
    await other.runtime.dispose();
    const row = [...bytes.rows.values()].find((value) => value.sessionId === first.sessionId);
    if (row === undefined) throw new Error('No record was stored.');
    const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
    body.events[0].actions.agentState = { agent: { progress: 1 } };
    bytes.rows.set(JSON.stringify([first.sessionId, '', row.id]), {
      ...row,
      checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(JSON.stringify(body)) },
    });
    const before = structuredClone([...bytes.rows]);
    const broken = await life(store, saving, { sessionId: first.sessionId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(broken.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
      expect(broken.model.seen).toEqual([]);
      expect(broken.writes).toEqual([]);
      expect(broken.instance.getSnapshot().run?.pending).toBeUndefined();
      expect([...bytes.rows]).toEqual(before);
    }
    const fine = await life(store, saving, { sessionId: other.sessionId });
    expect(await fine.instance.restore()).toBeDefined();
    expect((await approval(fine)).interactionId).toBe(untouched.interactionId);
    expect(fine.model.seen).toEqual([]);
    expect(fine.writes).toEqual([]);
  },
);

test('moving a paused author beside a ParallelAgent rejects restore before anything runs', async () => {
  const source = shared('adk-restore-parallel-tree');
  const store = await source.open();
  const first = await life(store, saving);
  await first.instance.start({ prompt: 'go' });
  await approval(first);
  const request = { op: 'get', executor: 'adk-js', sessionId: first.sessionId, namespace: '' };
  const before = structuredClone(await store.checkpoints.request(request));
  await first.runtime.dispose();
  const changed: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new SequentialAgent({
        name: 'flow',
        subAgents: [
          new LlmAgent({
            name: 'agent',
            model: host.adk.llm('agent'),
            tools: [host.adk.capabilityTool('docs.save@1', save)],
          }),
          new ParallelAgent({
            name: 'parallel',
            subAgents: ['left', 'right'].map(
              (name) => new LlmAgent({ name, model: host.adk.llm('agent') }),
            ),
          }),
        ],
      }),
      interaction: () => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'conformance.Approval/v1',
        props: { count: 1 },
      }),
    });
  const second = await life(store, saving, { sessionId: first.sessionId, factory: changed });
  await expect(second.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
  expect(second.model.seen).toEqual([]);
  expect(second.writes).toEqual([]);
  expect(second.instance.getSnapshot().run?.pending).toBeUndefined();
  expect(await store.checkpoints.request(request)).toEqual(before);
});

test('two gated calls reload as one interaction and finish after one answer', async () => {
  const source = shared('adk-restore-two-gated');
  const script: Reply = (seen) =>
    seen.messages.some((message) => message.type === 'tool')
      ? new AIMessage({ content: 'finished' })
      : new AIMessage({
          content: '',
          tool_calls: [0, 1].map((index) => ({
            id: `call_${index}`,
            name: 'docs_save_1',
            args: { q: `note_${index}` },
          })),
        });
  const first = await life(await source.open(), script);
  await first.instance.start({ prompt: 'go' });
  const submitted = await approval(first);
  expect(first.instance.getSnapshot().run?.pending).toMatchObject({ props: { count: 2 } });
  expect(first.writes).toEqual([]);
  await first.runtime.dispose();
  const second = await life(await source.open(), script, { sessionId: first.sessionId });
  expect(await second.instance.restore()).toBeDefined();
  const restored = await approval(second);
  expect(restored.interactionId).toBe(submitted.interactionId);
  expect(second.instance.getSnapshot().run?.pending).toMatchObject({ props: { count: 2 } });
  expect(second.model.seen).toEqual([]);
  expect(second.writes).toEqual([]);
  expect(
    (await second.instance.dispatch({ ...restored, payload: { indexes: [0, 1] } })).status,
  ).toBe('accepted');
  await waitForRunStatus(second.instance, 'succeeded');
  expect(second.writes).toEqual([{ q: 'note_0' }, { q: 'note_1' }]);
  expect(second.model.seen).toHaveLength(1);
});

test.skipIf(durable)(
  'a transfer confirmation rejects disagreement with either call author without affecting another session',
  async () => {
    const bytes = new MemoryByteCheckpoints();
    const store: Store = { checkpoints: bytes, recovery: new MemoryRecoveryStore(), close() {} };
    const transfer: AdkAgent = (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'parent',
          model: host.adk.llm('agent'),
          instruction: 'role=parent;',
          subAgents: [
            new LlmAgent({
              name: 'child',
              model: host.adk.llm('agent'),
              instruction: 'role=child;',
              tools: [host.adk.capabilityTool('docs.save@1', save)],
            }),
          ],
        }),
        interaction: (requests) => ({
          surfaceId: 'main',
          viewRevision: 'r1',
          component: 'conformance.Approval/v1',
          props: { count: requests.length },
        }),
      });
    const script: Reply = (seen) => {
      if (JSON.stringify(seen.messages[0]?.content).includes('role=parent;'))
        return new AIMessage({
          content: '',
          tool_calls: [
            { id: 'transfer', name: 'transfer_to_agent', args: { agent_name: 'child' } },
          ],
        });
      return saving(seen, 0);
    };
    const other = await life(store, script, { factory: transfer });
    await other.instance.start({ prompt: 'go' });
    const untouched = await approval(other);
    await other.runtime.dispose();
    for (const tool of ['docs_save_1', 'adk_request_confirmation']) {
      const first = await life(store, script, { factory: transfer });
      await first.instance.start({ prompt: 'go' });
      await approval(first);
      await first.runtime.dispose();
      const row = [...bytes.rows.values()].find((value) => value.sessionId === first.sessionId);
      if (row === undefined) throw new Error('No record was stored.');
      const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes));
      const held = body.events.filter(
        (event: { content?: { parts?: { functionCall?: { name?: string } }[] } }) =>
          event.content?.parts?.some((part) => part.functionCall?.name === tool),
      );
      expect(held).toHaveLength(1);
      held[0].author = 'parent';
      bytes.rows.set(JSON.stringify([first.sessionId, '', row.id]), {
        ...row,
        checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(JSON.stringify(body)) },
      });
      const before = structuredClone([...bytes.rows]);
      const broken = await life(store, script, { sessionId: first.sessionId, factory: transfer });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(broken.instance.restore()).rejects.toMatchObject({ code: 'unrecoverable' });
        expect(broken.model.seen).toEqual([]);
        expect(broken.writes).toEqual([]);
        expect(broken.instance.getSnapshot().run?.pending).toBeUndefined();
        expect([...bytes.rows]).toEqual(before);
      }
    }
    const fine = await life(store, script, { sessionId: other.sessionId, factory: transfer });
    expect(await fine.instance.restore()).toBeDefined();
    expect((await approval(fine)).interactionId).toBe(untouched.interactionId);
    expect(fine.model.seen).toEqual([]);
    expect(fine.writes).toEqual([]);
  },
);
