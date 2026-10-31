// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';
import {
  executePydanticReloadStep,
  joinPydanticReload,
  type PydanticReloadResult,
  pydanticReloadCases,
} from './support/pydantic-ai-restore.js';
import { pydanticSources } from './support/pydantic-ai-sources.node.js';

test.skipIf(!pythonWheelsAvailable)(
  'completion replaces an orphan interrupt marker from a failed pause commit',
  async () => {
    const name = 'approval-approve';
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
      });
      const id = '00000000000000000002';
      await store.checkpoints.request({
        executor: 'pydantic-ai-python',
        op: 'put-writes',
        sessionId: first.sessionId,
        namespace: '',
        id,
        taskId: 'conversation',
        taskPath: '',
        writes: [
          {
            channel: '__interrupt__',
            index: -3,
            interruptIds: ['orphan'],
            value: { type: 'json', bytes: new TextEncoder().encode('{"id":"orphan"}') },
          },
        ],
      });
      const result = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(result.transcript.error).toBeNull();
      const completed = (await store.checkpoints.request({
        executor: 'pydantic-ai-python',
        op: 'get',
        sessionId: first.sessionId,
        namespace: '',
      })) as { id: string; writes: { channel: string; value: { bytes: Uint8Array } }[] };
      expect(completed.id).toBe(id);
      const interrupt = completed.writes.find((row) => row.channel === '__interrupt__');
      expect(interrupt).toBeDefined();
      expect(new TextDecoder().decode(interrupt?.value.bytes)).toBe('null');
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'a failed completion commit restores the committed pause in the same Worker',
  async () => {
    const name = 'approved-write';
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const checkpoints = new MemoryByteCheckpoints();
    const recovery = new MemoryRecoveryStore();
    let failed = false;
    const store = {
      recovery,
      checkpoints: {
        async request(value: unknown): Promise<unknown> {
          const input = value as { op: string; parentId?: string | null };
          if (!failed && input.op === 'put' && input.parentId != null) {
            failed = true;
            throw new Error('Private host storage failure.');
          }
          return checkpoints.request(value);
        },
      },
    };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        accepted: true,
      });
      const retried = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        restoreAfterError: true,
      });
      expect(retried.transcript.error).toEqual({
        code: 'unavailable',
        message: 'The requested service is unavailable.',
      });
      expect(retried.retriedOutput).toBe('done');
      expect(retried.transcript.capabilities).toHaveLength(1);
      expect(retried.consumed).toBe(true);
      expect(recovery.journal.size).toBe(1);
      const fresh = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(fresh.pending).toBeUndefined();
      expect(fresh.transcript.requests).toEqual([]);
      expect(fresh.transcript.capabilities).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable).each(pydanticReloadCases)(
  'Node Pyodide restores a conversation in fresh Workers: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const steps: PydanticReloadResult[] = [];
    try {
      let result = await executePydanticReloadStep(fixture.options, fixture.agent, store, { name });
      steps.push(result);
      for (let index = 0; result.pending && index < 3; index++) {
        const before = result.pending;
        result = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: result.sessionId,
          answerIndex: index,
        });
        expect(result.restored).toEqual(before);
        steps.push(result);
      }
      const golden = JSON.parse(
        await readFile(new URL(`./golden-pydantic-ai/${name}.json`, import.meta.url), 'utf8'),
      );
      expect(joinPydanticReload(steps)).toEqual(golden);
      expect(fixture.counts.created).toBe(steps.length);
      expect(fixture.counts.terminated).toBe(steps.length);
      expect(fixture.workerErrors).toEqual([]);
      const rows = [...store.checkpoints.rows.values()];
      expect(rows.every((row) => row.executor === 'pydantic-ai-python')).toBe(true);
      const conversations = rows.map((row) =>
        JSON.parse(new TextDecoder().decode(row.checkpoint.bytes)),
      );
      expect(new Set(conversations.map((value) => value.conversation_id)).size).toBe(1);
      expect(conversations[0].deferred_tool_requests).not.toBeNull();
      if (result.transcript.error === null) {
        expect(result.consumed).toBe(true);
        expect(conversations.at(-1).deferred_tool_requests).toBeNull();
        expect(conversations.at(-1).usage.requests).toBe(golden.requests.length);
      }
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'Node Pyodide reconciles an answer accepted before reload',
  async () => {
    const name = 'approval-approve';
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        accepted: true,
      });
      const restored = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(restored.restored).toBeUndefined();
      expect(restored.transcript.output).toBe('The deferred result is ready.');
      expect(restored.transcript.capabilities).toHaveLength(1);
      expect(restored.consumed).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable).each(['approved-write', 'resumed-write'] as const)(
  'Node Pyodide replays a write receipt after Worker loss: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
      });
      const lost = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        crashAfterWrite: true,
      });
      expect(lost.crashed).toBe(true);
      expect(lost.transcript.capabilities).toHaveLength(1);
      expect(lost.consumed).toBe(false);
      const restored = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(restored.transcript.error).toBeNull();
      expect(restored.transcript.output).toBe('done');
      expect(restored.transcript.capabilities).toEqual([]);
      expect(restored.consumed).toBe(true);
      expect(store.recovery.journal.size).toBe(1);
      expect([...store.recovery.journal.values()][0]?.status).toBe('succeeded');
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'Node Pyodide refuses a changed replayed write without invoking it',
  async () => {
    const name = 'resumed-write';
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
      });
      const lost = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        crashAfterWrite: true,
      });
      expect(lost.crashed).toBe(true);
      const restored = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        changedWrite: true,
      });
      expect(restored.transcript.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(restored.transcript.capabilities).toEqual([]);
      expect(store.recovery.journal.size).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'Node Pyodide refuses a different executor before reading snapshots',
  async () => {
    const name = 'approval-approve';
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
      });
      const identity = store.recovery.sessions.get(first.sessionId);
      if (!identity) throw new Error('The recorded session identity is missing.');
      expect(identity.executorId).toBe('pydantic-ai-python');
      store.recovery.sessions.set(first.sessionId, { ...identity, executorId: 'langgraph-python' });
      const before = fixture.fromWorker.length;
      await expect(
        executePydanticReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'unsupported',
        message: 'The saved session uses a different executor.',
      });
      expect(
        fixture.fromWorker.slice(before).some((raw) => JSON.parse(raw).op === 'checkpoint'),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'Node Pyodide isolates a corrupt snapshot from another saved session',
  async () => {
    const name = 'approval-approve';
    const fixture = await createPythonFixture({
      sources: await pydanticSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const first = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
      });
      const other = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
      });
      for (const [key, row] of store.checkpoints.rows)
        if (row.sessionId === first.sessionId)
          store.checkpoints.rows.set(key, {
            ...row,
            checkpoint: {
              ...row.checkpoint,
              bytes: new TextEncoder().encode('private corrupt snapshot'),
            },
          });
      await expect(
        executePydanticReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      const restored = await executePydanticReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: other.sessionId,
      });
      expect(restored.restored).toEqual(other.pending);
      expect(restored.transcript.error).toBeNull();
      expect(restored.consumed).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);
