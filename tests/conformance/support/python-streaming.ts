// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie/core';
import { createMockLatch, MockChatModel } from '@galaxie/models/mock';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { normalize } from './normalize.js';

export const pythonStreamCases = ['linear', 'branching'] as const;
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
}

export async function executePythonStream(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<PythonStreamResult> {
  if (![...pythonStreamCases, ...pythonStreamProbes].some((item) => item === name))
    throw new Error('The conformance case is unknown.');
  const checks: { text: string; final: boolean }[] = [];
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
    outputSafety: ({ text, final }) => {
      checks.push({ text, final });
      return (name === 'block' || name === 'close-block') && text.includes('BLOCKED')
        ? 'block'
        : 'allow';
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
      }),
      {
        principalScope: 'fixture',
        agent,
        services: {
          chatModels: {
            mock: new StreamModel({
              'stream request': {
                id: 'stream-reply',
                text: 'allowed BLOCKED LATER',
                usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
              },
            }),
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
      name === 'linear' ? { value: 2 } : name === 'branching' ? { route: 'both' } : { kind: name },
    );
    const live: RunEvent[] = [];
    let closedWhileRunning = false;
    for await (const event of instance.events(runId)) {
      live.push(event);
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
      events,
      modes,
      final: live.find((event) => event.type === 'output')?.output ?? null,
      error: live.find((event) => event.type === 'error')?.error ?? null,
      replayModes,
      checks,
      cancelled: live.some((event) => event.type === 'cancelled'),
      closedWhileRunning,
      nextRunOutput,
    }) as unknown as PythonStreamResult;
  } finally {
    latch.release();
    await runtime.dispose();
  }
}
