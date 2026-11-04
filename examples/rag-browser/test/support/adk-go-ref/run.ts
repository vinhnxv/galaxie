// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Runs one ADK Go conformance case through the real adapter. The Node and Chromium lanes share it, so
// both observe the same program, the same scripted model and the same bridge traffic.

import { createRuntime, defineAgentDefinition, GalaxieError, type RunEvent } from '@galaxie/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createGoAdapter,
  type GoWorkerPort,
} from '../../../../../packages/adapter-go/src/index.js';

export interface ScriptedReply {
  readonly content?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly error?: string;
}
export interface Script {
  readonly entry: string;
  readonly prompt: string;
  readonly replies: ReadonlyArray<ScriptedReply>;
  readonly capabilities: Readonly<Record<string, { result?: unknown; error?: string }>>;
}
export interface Observed {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly output: string;
  readonly error: { code: string } | null;
  readonly coldStartMs: number | undefined;
}
export interface WasmReference {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Answers with the next scripted reply whatever the messages say; the goldens compare requests. */
export class ScriptedChatModel extends BaseChatModel {
  served = 0;
  readonly #replies: ReadonlyArray<ScriptedReply>;
  constructor(replies: ReadonlyArray<ScriptedReply>) {
    super({});
    this.#replies = replies;
  }
  override _llmType(): string {
    return 'galaxie-adk-go-scripted';
  }
  override bindTools(): ScriptedChatModel {
    return this;
  }
  override async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const reply = this.#replies[this.served++];
    if (reply === undefined) throw new GalaxieError('unavailable', 'No scripted reply is left.');
    if (reply.error !== undefined)
      throw new GalaxieError(reply.error as 'unavailable', 'A scripted model failure.');
    const message = new AIMessage({
      content: reply.content ?? '',
      tool_calls: (reply.toolCalls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments) as Record<string, unknown>,
      })),
    });
    return { generations: [{ text: reply.content ?? '', message }] };
  }
}

const definition = defineAgentDefinition({
  id: 'conformance/adk-go',
  version: '1.0.0',
  executor: 'adk-go',
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'read',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});

/** Runs one case against the reference module and records what the program sent the page. */
export async function runCase(
  name: string,
  script: Script,
  wasm: WasmReference,
  createWorker: () => GoWorkerPort,
): Promise<Observed> {
  const frames: Array<{ op: string; payload: unknown }> = [];
  let coldStartMs: number | undefined;
  const model = new ScriptedChatModel(script.replies);
  const runtime = createRuntime({
    appId: `adk-go-${name}`,
    executors: [
      createGoAdapter({
        createWorker: () => {
          const port = createWorker();
          port.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            const message = JSON.parse(event.data) as {
              kind: string;
              op?: string;
              payload?: string;
            };
            if (message.kind === 'call' && message.op && message.payload)
              frames.push({ op: message.op, payload: JSON.parse(message.payload) });
          });
          return port;
        },
        onBoot: (event) => {
          if (event.phase === 'ready') coldStartMs = event.coldStartMs;
        },
      }),
    ],
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'fixture',
      agent: { wasm, entry: script.entry },
      services: { chatModels: { mock: model } },
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
      bindings: {
        'math.double@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 5000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: async () => {
            const outcome = script.capabilities['math.double@1'];
            if (outcome?.error)
              throw new GalaxieError(outcome.error as 'denied', 'Scripted failure.');
            return outcome?.result as { value: number };
          },
        },
      },
    });
    await instance.prepare();
    const { runId } = await instance.start({ prompt: script.prompt });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) events.push(event);
    const end = events.at(-1);
    return {
      requests: frames.filter((frame) => frame.op === 'model').map((frame) => frame.payload),
      responses: script.replies.slice(0, model.served),
      capabilities: frames
        .filter((frame) => frame.op === 'capability')
        .map((frame) => frame.payload),
      output: end?.type === 'output' ? String(end.output) : '',
      error: end?.type === 'error' ? { code: end.error.code } : null,
      coldStartMs,
    };
  } finally {
    await runtime.dispose();
  }
}
