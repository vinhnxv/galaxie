// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie/core';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  comparable,
  type Durability,
  runCase,
  ScriptedChatModel,
} from '../../examples/rag-browser/test/support/adk-go-ref/run.js';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import { decodeStored, encodeStored } from '../../packages/adapter-go/src/persist.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import {
  buildReference,
  disposeReference,
  goAvailable,
  missingGo,
  type NodeHost,
  readGolden,
  readScripts,
  type Script,
  startNodeHost,
} from './support/adk-go.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const scripts = await readScripts();
const pausing = Object.keys(scripts).filter((name) => (scripts[name]?.answers?.length ?? 0) > 0);

let host: NodeHost | undefined;
beforeAll(async () => {
  if (goAvailable) host = await startNodeHost(await buildReference());
}, 600000);
afterAll(async () => {
  await host?.close();
  await disposeReference();
});

/** Storage that outlives every runtime, as a page's storage outlives a reload. */
function storage(onReopen?: (bytes: MemoryByteCheckpoints, opened: number) => Promise<void>): {
  readonly bytes: MemoryByteCheckpoints;
  readonly durable: Durability;
  opened(): number;
} {
  const bytes = new MemoryByteCheckpoints();
  const recovery = new MemoryRecoveryStore();
  let opened = 0;
  return {
    bytes,
    opened: () => opened,
    durable: {
      async open() {
        opened += 1;
        await onReopen?.(bytes, opened);
        return { checkpoints: bytes, recovery, close() {} };
      },
    },
  };
}

function run(name: string, script: Script, durable: Durability): ReturnType<typeof runCase> {
  if (!host) throw new Error('The host did not start.');
  const nodeHost = host;
  return runCase(name, script, nodeHost.wasm, () => nodeHost.createWorker(), durable);
}

test.skipIf(!goAvailable).each(pausing)(
  goAvailable
    ? 'a reload and a new Worker at every pause reproduce the native golden for %s'
    : missingGo,
  async (name) => {
    const script = scripts[name] as Script;
    const { durable, opened } = storage();
    const observed = await run(name, script, durable);
    expect(comparable(observed)).toEqual(await readGolden(name));
    expect(observed.streams).toEqual(script.streams ?? []);
    // One open for the first life plus one per pause: no run kept a Worker across a reload.
    expect(opened()).toBe(1 + observed.pauses.length);
  },
  120000,
);

/** Rewrites the stored record the way an attacker with the page's storage could. */
async function restamp(
  bytes: MemoryByteCheckpoints,
  edit: (body: Record<string, unknown>) => void,
): Promise<void> {
  const [row] = [...bytes.rows.values()];
  if (row === undefined) throw new Error('No record was stored.');
  const metadata = JSON.parse(new TextDecoder().decode(row.metadata.bytes)) as {
    key: string;
    position: number;
  };
  const key = Uint8Array.from(atob(metadata.key), (char) => char.charCodeAt(0));
  const body = JSON.parse(new TextDecoder().decode(row.checkpoint.bytes)) as Record<
    string,
    unknown
  >;
  edit(body);
  const forged = await encodeStored(row.sessionId, body as never, metadata.position, key);
  bytes.rows.set(JSON.stringify([row.sessionId, row.namespace, row.id]), {
    ...row,
    checkpoint: { ...row.checkpoint, bytes: forged.checkpoint },
    metadata: { ...row.metadata, bytes: forged.metadata },
  });
  // The forged record must still pass the page's own checks, so only the program can catch it.
  await decodeStored(row.sessionId, {
    id: row.id,
    checkpoint: { type: row.checkpoint.type, bytes: forged.checkpoint },
    metadata: { type: row.metadata.type, bytes: forged.metadata },
  });
}

interface StoredCall {
  name: string;
  args: Record<string, unknown>;
}
/** Finds a stored function call by name in a record's events. */
const callNamed = (body: Record<string, unknown>, name: string): StoredCall | undefined => {
  const events = body['events'] as Array<{
    content?: { parts?: Array<{ functionCall?: StoredCall }> };
  }>;
  for (const event of events)
    for (const part of event.content?.parts ?? [])
      if (part.functionCall?.name === name) return part.functionCall;
  return undefined;
};

test.skipIf(!goAvailable)(
  goAvailable
    ? 'a stored call edited under a valid stamp fails before any capability runs'
    : missingGo,
  async () => {
    const script = scripts['confirm-approve'] as Script;
    const { durable } = storage(async (bytes, opened) => {
      if (opened === 2)
        await restamp(bytes, (body) => {
          const call = callNamed(body, 'adk_request_confirmation');
          if (call === undefined) throw new Error('The record holds no confirmation call.');
          call.args = JSON.parse(JSON.stringify(call.args).replace('21', '99'));
        });
    });
    const observed = await run('forged-call', script, durable);
    expect(observed.error).not.toBeNull();
    expect(observed.capabilities).toEqual([]);
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'an edit to the original call event does not change the arguments the capability receives'
    : missingGo,
  async () => {
    const script = scripts['confirm-approve'] as Script;
    const { durable } = storage(async (bytes, opened) => {
      if (opened === 2)
        await restamp(bytes, (body) => {
          const call = callNamed(body, 'math_double_1');
          if (call === undefined) throw new Error('The record holds no original call.');
          call.args['value'] = 99;
        });
    });
    // The approved arguments live in the confirmation request the user saw, which is verified.
    // The history the model sees is part of the record: whoever can rewrite the key and the tag
    // together can change it, which the stamp does not claim to prevent.
    const observed = await run('forged-original', script, durable);
    expect(observed.error).toBeNull();
    expect(observed.capabilities).toEqual((await readGolden('confirm-approve')).capabilities);
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'a forged interaction digest under a valid stamp is refused as stale or invalid'
    : missingGo,
  async () => {
    const script = scripts['confirm-approve'] as Script;
    const { durable } = storage(async (bytes, opened) => {
      if (opened === 2)
        await restamp(bytes, (body) => {
          const pause = body['pause'] as { id: string };
          pause.id = 'f'.repeat(64);
        });
    });
    // The page reads the forged id as the pending interaction and the program refuses it.
    const observed = await run('forged-digest', script, durable).catch(
      (error: unknown) => ({ failure: String(error) }) as const,
    );
    if ('failure' in observed) expect(observed.failure).toBeTruthy();
    else {
      expect(observed.error).not.toBeNull();
      expect(observed.capabilities).toEqual([]);
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'a record edited without the key never restores' : missingGo,
  async () => {
    const script = scripts['confirm-approve'] as Script;
    const { durable } = storage(async (bytes, opened) => {
      if (opened !== 2) return;
      const [row] = [...bytes.rows.values()];
      if (row === undefined) throw new Error('No record was stored.');
      const text = new TextDecoder().decode(row.checkpoint.bytes).replace('21', '99');
      bytes.rows.set(JSON.stringify([row.sessionId, row.namespace, row.id]), {
        ...row,
        checkpoint: { ...row.checkpoint, bytes: new TextEncoder().encode(text) },
      });
    });
    await expect(run('unkeyed-edit', script, durable)).rejects.toThrow();
  },
  120000,
);

const writing = defineAgentDefinition({
  id: 'conformance/adk-go-restore-write',
  version: '1.0.0',
  executor: 'adk-go',
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'write',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});

test.skipIf(!goAvailable)(
  goAvailable
    ? 'an approved write executed before a failed resume replays its receipt after a restore'
    : missingGo,
  async () => {
    const nodeHost = host;
    if (!nodeHost) throw new Error('The host did not start.');
    const bytes = new MemoryByteCheckpoints();
    const recovery = new MemoryRecoveryStore();
    const model = new ScriptedChatModel([
      {
        content: '',
        toolCalls: [{ id: 'p1', function: { name: 'math_double_1', arguments: '{"value":21}' } }],
      },
      // The first resume reaches the model after the write ran and fails there, as a crash would.
      { error: 'unavailable' },
      { content: 'The result is 42.' },
    ]);
    const writes: number[] = [];
    const life = async (sessionId?: SessionId) => {
      const runtime = createRuntime({
        appId: 'adk-go-restore-write',
        executors: [createGoAdapter({ createWorker: () => nodeHost.createWorker() })],
        budgets: { steps: 10, toolCalls: 10, tokens: 5000 },
        outputSafety: () => 'allow',
      });
      const instance = await runtime.create(writing, {
        principalScope: 'fixture',
        ...(sessionId === undefined ? {} : { sessionId }),
        recovery,
        agent: { wasm: nodeHost.wasm, entry: 'confirm' },
        services: { chatModels: { mock: model }, checkpoints: bytes },
        bindings: {
          'math.double@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 5000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              writes.push(input.value);
              return { value: input.value * 2 };
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['tool-calling'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      });
      await instance.prepare();
      return { runtime, instance };
    };
    const status = (current: Awaited<ReturnType<typeof life>>) =>
      current.instance.getSnapshot().run?.status;
    const approval = (current: Awaited<ReturnType<typeof life>>): UserInteractionEvent => {
      const run = current.instance.getSnapshot().run;
      if (run?.pending === undefined) throw new Error('The run did not pause.');
      return {
        instanceId: current.instance.instanceId,
        runId: run.runId,
        ...run.pending,
        action: 'approve',
        payload: { indexes: [0] },
      };
    };

    const first = await life();
    await first.instance.start({ prompt: 'Double 21.' });
    await vi.waitFor(() => expect(status(first)).toBe('waiting_input'));
    await first.instance.dispatch(approval(first));
    await vi.waitFor(() => expect(status(first)).toBe('failed'));
    expect(writes).toEqual([21]);
    await first.runtime.dispose();

    const second = await life(first.instance.sessionId);
    expect(await second.instance.restore()).toBeDefined();
    await vi.waitFor(() => expect(['waiting_input', 'succeeded']).toContain(status(second)));
    if (status(second) === 'waiting_input') await second.instance.dispatch(approval(second));
    await vi.waitFor(() => expect(status(second)).toBe('succeeded'));
    // The second life replayed the stored receipt instead of writing again.
    expect(writes).toEqual([21]);
    await second.runtime.dispose();
  },
  120000,
);
