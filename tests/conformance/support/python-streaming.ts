// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie-ai/core';
import { createMockLatch, MockChatModel } from '@galaxie-ai/models/mock';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import {
  type CapabilityPayload,
  parseBridge,
  type StreamPayload,
} from '../../../packages/adapter-pyodide/src/bridge.js';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import { normalize } from './normalize.js';

export interface PythonScopeTrace {
  readonly capabilities: string[];
  readonly streams: string[];
}

export function recordPythonScopes(raw: unknown, scopes: PythonScopeTrace): void {
  const message = parseBridge(raw);
  if (message.kind === 'request' && message.op === 'capability') {
    const scope = (message.payload as CapabilityPayload).effectScope;
    if (scope !== undefined) scopes.capabilities.push(scope);
  } else if (message.kind === 'notify' && message.op === 'stream') {
    const [, mode, data] = message.payload as StreamPayload;
    if (
      mode === 'custom' &&
      typeof data === 'object' &&
      data !== null &&
      'scope' in data &&
      typeof data.scope === 'string'
    )
      scopes.streams.push(data.scope);
  }
}

export const pythonStreamCases = [
  'linear',
  'branching',
  'subgraph',
  'interrupt-subgraph',
  'model-without-config',
  'model-failure',
  'capability',
  'step-limit',
] as const;
export const pythonStreamProbes = [
  'allow',
  'block',
  'cancel',
  'close',
  'close-block',
  'non-json',
  'oversized',
] as const;

export interface PythonStreamResult {
  readonly events: Readonly<Record<string, { path: readonly string[]; data: unknown }[]>>;
  readonly modes: string[];
  readonly final: unknown;
  readonly error: unknown;
  readonly replayModes: string[];
  readonly checks: { text: string; final: boolean }[];
  readonly cancelled: boolean;
  readonly closedWhileRunning: boolean;
  readonly nextRunOutput: unknown;
  readonly pauses: { interrupts: { id: string; value: unknown }[] }[];
  readonly modelCalls: number;
  readonly capabilityCalls: number;
  readonly effects: readonly string[];
}

/** Provider-generated message IDs are not preserved by the text-only model bridge. */
export function pythonStreamComparison(name: string, events: unknown): unknown {
  const copy = structuredClone(events) as PythonStreamResult['events'];
  if (name === 'model-without-config')
    for (const event of copy['messages'] ?? []) {
      const [message] = event.data as [Record<string, unknown>];
      delete message['id'];
    }
  return copy;
}

export async function executePythonStream(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<PythonStreamResult> {
  if (![...pythonStreamCases, ...pythonStreamProbes, 'effect-scopes'].some((item) => item === name))
    throw new Error('The conformance case is unknown.');
  const checks: { text: string; final: boolean }[] = [];
  let capabilityCalls = 0;
  const effects: string[] = [];
  const latch = createMockLatch();
  class StreamModel extends MockChatModel {
    override async *_streamResponseChunks(
      messages: BaseMessage[],
      options: this['ParsedCallOptions'],
    ): AsyncGenerator<ChatGenerationChunk> {
      for await (const chunk of super._streamResponseChunks(messages, options)) {
        yield chunk;
        if (name === 'cancel' || name === 'close' || name === 'close-block')
          await latch.wait(options.signal);
      }
    }
  }
  const runtime = createRuntime({
    appId: 'python-streams',
    executors: [createPyodideAdapter(options)],
    budgets: { steps: 25 },
    outputSafety: ({ text, final }) => {
      checks.push({ text, final });
      return (name === 'block' || name === 'close-block') && text.includes('BLOCKED')
        ? 'block'
        : 'allow';
    },
  });
  const model = new StreamModel({
    'implicit request': {
      id: 'reply-implicit',
      text: 'implicit response',
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    },
    'failure request': { error: new Error('The conformance fixture failed.') },
    'stream request': {
      id: 'stream-reply',
      text: 'allowed BLOCKED LATER',
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    },
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/python-stream',
        version: '1.0.0',
        executor: 'langgraph-python',
        input: z.unknown(),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'save@1': {
              kind: 'write',
              input: z.object({ value: z.number() }),
              output: z.object({ effectId: z.string().uuid() }),
            },
            'double@1': {
              kind: 'read',
              input: z.object({ value: z.number() }),
              output: z.object({ value: z.number() }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        recovery: new MemoryRecoveryStore(),
        agent,
        services: {
          chatModels: { mock: model },
        },
        bindings: {
          'save@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(_input, context) {
              effects.push(context.effectId);
              return { effectId: context.effectId };
            },
          },
          'double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              capabilityCalls++;
              return { value: input.value * 2 };
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start(
      name === 'branching'
        ? { route: 'both' }
        : (pythonStreamCases as readonly string[]).includes(name)
          ? {
              value:
                name === 'step-limit'
                  ? 0
                  : name === 'subgraph'
                    ? 3
                    : name === 'linear' || name === 'capability'
                      ? 2
                      : 1,
            }
          : { kind: name },
    );
    const live: RunEvent[] = [];
    const pauses: PythonStreamResult['pauses'] = [];
    let closedWhileRunning = false;
    for await (const event of instance.events(runId)) {
      live.push(event);
      if (event.type === 'interaction') {
        const { interactionId, ...value } = event.interaction;
        pauses.push({ interrupts: [{ id: interactionId, value }] });
        const receipt = await instance.dispatch({
          instanceId: instance.instanceId,
          runId,
          ...event.interaction,
          action: 'submit',
          payload: 'inner answer',
        });
        if (receipt.status !== 'accepted') throw new Error('The Python answer was rejected.');
      }
      if (name === 'cancel' && event.type === 'stream' && event.mode === 'custom')
        await instance.cancel(runId);
      if (name === 'close' && event.type === 'stream' && event.mode === 'custom') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        closedWhileRunning = instance.getSnapshot().run?.status === 'running';
        latch.release();
      }
      if (name === 'close-block' && event.type === 'stream' && event.mode === 'custom')
        latch.release();
    }
    const events: Record<string, { path: readonly string[]; data: unknown }[]> = {
      values: [],
      updates: [],
      messages: [],
      custom: [],
    };
    const modes: string[] = [];
    for (const event of live)
      if (event.type === 'stream') {
        if (event.executor !== 'langgraph-python') throw new Error('Unexpected stream executor.');
        events[event.mode]?.push({ path: event.path, data: event.data });
        modes.push(event.mode);
      }
    const replayModes: string[] = [];
    for await (const event of instance.events(runId))
      if (event.type === 'stream') replayModes.push(event.mode);
    let nextRunOutput: unknown = null;
    if (name === 'close') {
      const next = await instance.start({ kind: 'allow' });
      for await (const event of instance.events(next.runId))
        if (event.type === 'output') nextRunOutput = event.output;
    }
    return normalize({
      events: pythonStreamComparison(name, events),
      modes,
      final: live.find((event) => event.type === 'output')?.output ?? null,
      error: live.find((event) => event.type === 'error')?.error ?? null,
      replayModes,
      checks,
      cancelled: live.some((event) => event.type === 'cancelled'),
      closedWhileRunning,
      nextRunOutput,
      pauses,
      modelCalls: model.calls,
      capabilityCalls,
      effects,
    }) as unknown as PythonStreamResult;
  } finally {
    latch.release();
    await runtime.dispose();
  }
}
