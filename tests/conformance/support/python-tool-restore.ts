// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryStore,
  type SessionId,
} from '@galaxie-ai/core';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { MockChatModel } from '../../../packages/models/src/mock.js';
import { confirmationsFor } from './auto-confirm.js';

export interface ToolReloadResult {
  sessionId: string;
  pending?: PendingInteraction;
  restored?: PendingInteraction;
  final?: unknown;
  calls: unknown[];
  writes: number;
}

/** One page owns one runtime/Worker; the next page adopts its durable session. */
export async function executeToolReload(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: { checkpoints: { request(value: unknown): Promise<unknown> }; recovery: RecoveryStore },
  replay: boolean,
  sessionId?: string,
): Promise<ToolReloadResult> {
  const calls: unknown[] = [];
  let writes = 0;
  const model = new MockChatModel({
    write: {
      id: 'write-request',
      text: JSON.stringify({ calls: [{ name: 'write@1', input: { value: 4 } }] }),
    },
    '["saved"]': { id: 'final', text: 'done' },
  });
  const runtime = createRuntime({
    appId: 'python-tool-reload',
    executors: [createPyodideAdapter(options)],
    outputSafety: () => 'allow',
  });
  try {
    const input = z.object({ value: z.number().int() });
    const binding = {
      destination: 'in-browser' as const,
      timeoutMs: 1000,
      concurrency: 1,
      grantScope: 'instance' as const,
      retry: 'none' as const,
    };
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/python-tool-reload',
        version: '1',
        executor: 'langgraph-python',
        input: z.unknown(),
        models: { answer: { modality: 'text', defaultPolicy: 'remote-allowed' } },
        capabilities: {
          required: {
            'read@1': { kind: 'read', input, output: z.string() },
            'write@1': { kind: 'write', input, output: z.string() },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        recovery: store.recovery,
        ...(sessionId ? { sessionId: sessionId as SessionId } : {}),
        confirmations: confirmationsFor(['write@1'], 'tool-reload-v1'),
        services: { checkpoints: store.checkpoints, chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
        bindings: {
          'read@1': {
            ...binding,
            kind: 'read',
            approval: 'none',
            invoke: async (value) => {
              calls.push(['read@1', value]);
              return '4';
            },
          },
          'write@1': {
            ...binding,
            kind: 'write',
            approval: 'confirm',
            invoke: async (value) => {
              writes++;
              calls.push(['write@1', value]);
              return 'saved';
            },
          },
        },
      },
    );
    await instance.prepare();
    const run = sessionId
      ? await instance.restore()
      : await instance.start({ scenario: 'write', durable: true, replay });
    if (!run) throw new Error('Missing tool reload run.');
    const restored = instance.getSnapshot().run?.pending;
    if (sessionId) {
      if (!restored) throw new Error('Missing restored tool interaction.');
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        action: 'submit',
        payload: false,
      });
      if (receipt.status !== 'accepted') throw new Error('Tool interaction was rejected.');
    }
    const approve = setInterval(() => {
      for (const confirmation of instance.getSnapshot().confirmations ?? [])
        instance.respond(confirmation.id, 'approve');
    }, 5);
    try {
      let final: unknown;
      for await (const event of instance.events(run.runId)) {
        if (event.type === 'error') throw new Error(`${event.error.code}: ${event.error.message}`);
        if (event.type === 'interaction' && !sessionId) {
          const pending = instance.getSnapshot().run?.pending;
          if (!pending) throw new Error('Missing durable tool interaction.');
          return {
            sessionId: instance.sessionId,
            pending,
            calls,
            writes,
          };
        }
        if (event.type === 'output') final = event.output;
      }
      return {
        sessionId: instance.sessionId,
        ...(restored ? { restored } : {}),
        final,
        calls,
        writes,
      };
    } finally {
      clearInterval(approve);
    }
  } finally {
    await runtime.dispose();
  }
}
