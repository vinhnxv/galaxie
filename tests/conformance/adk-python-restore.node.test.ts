// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import {
  type AdkReloadResult,
  adkPythonReloadCases,
  executeAdkReloadStep,
  joinAdkReload,
} from './support/adk-python-restore.js';
import { adkPythonSources, adkPythonWriteSources } from './support/adk-python-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const fresh = () => ({
  checkpoints: new MemoryByteCheckpoints(),
  recovery: new MemoryRecoveryStore(),
});

test.skipIf(!pythonWheelsAvailable)(
  'completion replaces an orphan interrupt marker from a failed pause commit',
  async () => {
    const name = 'confirm-approve';
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      const id = '00000000000000000002';
      await store.checkpoints.request({
        executor: 'adk-python',
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
      const result = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(result.transcript.error).toBeNull();
      const completed = (await store.checkpoints.request({
        executor: 'adk-python',
        op: 'get',
        sessionId: first.sessionId,
        namespace: '',
      })) as { id: string; writes: { channel: string; value: { bytes: Uint8Array } }[] };
      expect(completed.id).toBe(id);
      const interrupt = completed.writes.find((row) => row.channel === '__interrupt__');
      expect(interrupt).toBeDefined();
      expect(decode(interrupt?.value.bytes ?? new Uint8Array())).toBe('null');
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable).each(adkPythonReloadCases)(
  'Node Pyodide restores a conversation in fresh Workers: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    const store = fresh();
    const steps: AdkReloadResult[] = [];
    try {
      let result = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      steps.push(result);
      for (let index = 0; result.pending && index < 3; index++) {
        const before = result.pending;
        result = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: result.sessionId,
          answerIndex: index,
        });
        expect(result.restored).toEqual(before);
        steps.push(result);
      }
      const golden = JSON.parse(
        await readFile(new URL(`./golden-adk-python/${name}.json`, import.meta.url), 'utf8'),
      );
      expect(joinAdkReload(steps)).toEqual(golden);
      expect(fixture.counts.created).toBe(steps.length);
      expect(fixture.counts.terminated).toBe(steps.length);
      expect(fixture.workerErrors).toEqual([]);
      const rows = [...store.checkpoints.rows.values()];
      expect(rows.every((row) => row.executor === 'adk-python')).toBe(true);
      const records = rows.map((row) => JSON.parse(decode(row.checkpoint.bytes)));
      expect(new Set(records.map((value) => value.conversation_id)).size).toBe(1);
      // The key lives in the metadata only, never in the checkpoint bytes or the interrupt write.
      const keys = rows.map((row) => JSON.parse(decode(row.metadata.bytes)).key as string);
      expect(new Set(keys).size).toBe(1);
      for (const row of rows) expect(decode(row.checkpoint.bytes)).not.toContain(keys[0]);
      expect(
        JSON.parse(decode(rows[0]?.metadata.bytes ?? new Uint8Array())).pending,
      ).not.toBeNull();
      if (result.transcript.error === null) {
        expect(result.consumed).toBe(true);
        const last = JSON.parse(decode(rows.at(-1)?.metadata.bytes ?? new Uint8Array()));
        expect(last.pending).toBeNull();
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
    const name = 'confirm-approve';
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        accepted: true,
      });
      const restored = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(restored.restored).toBeUndefined();
      expect(restored.transcript.output).toBe('The confirmed result is ready.');
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
      framework: 'adk',
      sources: await adkPythonWriteSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      expect(first.pending).toBeDefined();
      const lost = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        crashAfterWrite: true,
      });
      expect(lost.crashed).toBe(true);
      expect(
        lost.transcript.capabilities.filter(
          (call) => (call as { name: string }).name === 'math.double@1',
        ),
      ).toHaveLength(1);
      expect(lost.consumed).toBe(false);
      const restored = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
      });
      expect(restored.transcript.error).toBeNull();
      expect(restored.transcript.output).toBe('done');
      expect(
        restored.transcript.capabilities.filter(
          (call) => (call as { name: string }).name === 'math.double@1',
        ),
      ).toEqual([]);
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
      framework: 'adk',
      sources: await adkPythonWriteSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      const lost = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        crashAfterWrite: true,
      });
      expect(lost.crashed).toBe(true);
      const restored = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
        name,
        sessionId: first.sessionId,
        changedWrite: true,
      });
      expect(restored.transcript.error).toEqual({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(
        restored.transcript.capabilities.filter(
          (call) => (call as { name: string }).name === 'math.double@1',
        ),
      ).toEqual([]);
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
    const name = 'confirm-approve';
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      const identity = store.recovery.sessions.get(first.sessionId);
      if (!identity) throw new Error('The recorded session identity is missing.');
      expect(identity.executorId).toBe('adk-python');
      store.recovery.sessions.set(first.sessionId, { ...identity, executorId: 'langgraph-python' });
      const before = fixture.fromWorker.length;
      await expect(
        executeAdkReloadStep(fixture.options, fixture.agent, store, {
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

/** Each change to a stored pause that the session key or the pause check must refuse. */
const tamper: Record<
  string,
  (row: { checkpoint: { bytes: Uint8Array }; metadata: { bytes: Uint8Array } }) => void
> = {
  key: (row) => {
    const metadata = JSON.parse(decode(row.metadata.bytes));
    metadata.key = Buffer.alloc(32, 7).toString('base64');
    row.metadata.bytes = encode(metadata);
  },
  'call arguments': (row) => {
    const record = JSON.parse(decode(row.checkpoint.bytes));
    for (const event of record.events)
      for (const part of event.content?.parts ?? [])
        if (part.functionCall?.name === 'double') part.functionCall.args.value = 99;
    row.checkpoint.bytes = encode(record);
  },
  'pending request': (row) => {
    const metadata = JSON.parse(decode(row.metadata.bytes));
    metadata.pending.asks[0].args = { value: 99 };
    row.metadata.bytes = encode(metadata);
  },
  'interaction id': (row) => {
    const metadata = JSON.parse(decode(row.metadata.bytes));
    metadata.pending.interaction.id = 'forged';
    row.metadata.bytes = encode(metadata);
  },
};

test.skipIf(!pythonWheelsAvailable).each(Object.keys(tamper))(
  'Node Pyodide refuses a stored pause with a changed %s and runs no tool',
  async (change) => {
    const name = 'confirm-approve';
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      for (const row of store.checkpoints.rows.values()) tamper[change]?.(row);
      await expect(
        executeAdkReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'Node Pyodide isolates a corrupt snapshot from another saved session',
  async () => {
    const name = 'confirm-approve';
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources(name),
      module: 'selected',
    });
    const store = fresh();
    try {
      const first = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
      const other = await executeAdkReloadStep(fixture.options, fixture.agent, store, { name });
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
        executeAdkReloadStep(fixture.options, fixture.agent, store, {
          name,
          sessionId: first.sessionId,
        }),
      ).rejects.toMatchObject({
        code: 'unrecoverable',
        message: 'Stored state cannot be recovered.',
      });
      const restored = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
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
