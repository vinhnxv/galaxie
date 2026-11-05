// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime } from '@galaxie/core';
import { MockChatModel, type MockScript } from '@galaxie/models/mock';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { ragDefinition } from '../../src/agent/definition.js';
import { createRagAgent } from '../../src/agent/graph.js';
import type { RagInput, RagOutput, SearchInput, SearchResult } from '../../src/agent/schemas.js';
import { reviewRegistry } from '../../src/host/review-passages.js';
import type { IndexedPassage } from '../../src/retrieval/index.js';
import script from '../golden/script.json' with { type: 'json' };
import golden from '../golden/session.json' with { type: 'json' };

export interface TranscriptMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export type TranscriptEntry =
  | { readonly type: 'interaction'; readonly component: string; readonly props: unknown }
  | { readonly type: 'capability'; readonly name: string; readonly input: SearchInput }
  | {
      readonly type: 'model';
      readonly role: string;
      readonly messages: readonly TranscriptMessage[];
    }
  | { readonly type: 'output'; readonly output: RagOutput };

export interface ParityScript {
  readonly corpus: readonly IndexedPassage[];
  readonly session: readonly {
    readonly input: RagInput;
    readonly search: SearchResult;
    readonly model: {
      readonly role: string;
      readonly messages: readonly TranscriptMessage[];
      readonly reply: string;
    };
  }[];
}

export const parityScript: ParityScript = script as ParityScript;
export const goldenTranscript: readonly TranscriptEntry[] = golden as TranscriptEntry[];

function difference(actual: unknown, expected: unknown, path: string): string | undefined {
  if (Object.is(actual, expected)) return undefined;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return `${path}.length`;
    for (let index = 0; index < actual.length; index++) {
      const next = difference(actual[index], expected[index], `${path}[${index}]`);
      if (next !== undefined) return next;
    }
    return undefined;
  }
  if (
    typeof actual === 'object' &&
    actual !== null &&
    !Array.isArray(actual) &&
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(expected)
  ) {
    const left = Object.keys(actual).sort();
    const right = Object.keys(expected).sort();
    if (left.length !== right.length || left.some((key, index) => key !== right[index]))
      return `${path}.keys`;
    for (const key of left) {
      const next = difference(
        Reflect.get(actual, key),
        Reflect.get(expected, key),
        `${path}.${key}`,
      );
      if (next !== undefined) return next;
    }
    return undefined;
  }
  return path;
}

export function assertTranscript(actual: unknown, expected: unknown): void {
  const changed = difference(actual, expected, '$');
  if (changed !== undefined) throw new Error(`The transcript differs at ${changed}.`);
}

export function normalizeMessages(messages: readonly BaseMessage[]): TranscriptMessage[] {
  return messages.map((message) => {
    const role =
      message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type;
    if (!['system', 'user', 'assistant'].includes(role) || typeof message.content !== 'string')
      throw new Error('The transcript model message is unsupported.');
    return { role: role as TranscriptMessage['role'], content: message.content };
  });
}

export function createTranscriptReplay(
  source: ParityScript,
  transcript: TranscriptEntry[],
): {
  readonly model: MockChatModel;
  search(input: SearchInput): Promise<SearchResult>;
} {
  const replies: MockScript = Object.fromEntries(
    source.session.map(({ model }, index) => {
      const human = model.messages.findLast((message) => message.role === 'user');
      if (!human) throw new Error('The scripted model call has no user message.');
      return [human.content, { id: `parity-${index}`, text: model.reply }];
    }),
  );
  class RecordingModel extends MockChatModel {
    private record(messages: BaseMessage[]): void {
      transcript.push({ type: 'model', role: 'rag.answer', messages: normalizeMessages(messages) });
    }
    override async _generate(
      messages: BaseMessage[],
      options: this['ParsedCallOptions'],
    ): Promise<ChatResult> {
      this.record(messages);
      return super._generate(messages, options);
    }
    override async *_streamResponseChunks(
      messages: BaseMessage[],
      options: this['ParsedCallOptions'],
      manager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatGenerationChunk> {
      this.record(messages);
      yield* super._streamResponseChunks(messages, options, manager);
    }
  }
  return {
    model: new RecordingModel(replies),
    async search(input) {
      const item = source.session.find(
        ({ input: query }) =>
          query.question === input.query && query.mode === input.mode && input.k === 10,
      );
      if (!item) throw new Error('The capability call has no scripted search result.');
      transcript.push({ type: 'capability', name: 'docs.search@1', input: structuredClone(input) });
      return structuredClone(item.search);
    },
  };
}

export async function replayJavaScript(source: ParityScript): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const replay = createTranscriptReplay(source, transcript);
  const runtime = createRuntime({
    appId: 'rag-parity',
    executors: [createLangGraphAdapter()],
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(ragDefinition, {
      principalScope: 'fixture',
      ui: reviewRegistry.bindings({ surfaces: ['rag-review'] }),
      agent: createRagAgent(),
      services: { chatModels: { mock: replay.model } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            features: [],
            languages: ['en'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 500 } },
      },
      bindings: {
        'docs.search@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: replay.search,
        },
      },
    });
    await instance.prepare();
    for (const item of source.session) {
      const { runId } = await instance.start(item.input);
      for await (const event of instance.events(runId)) {
        if (event.type === 'output')
          transcript.push({ type: 'output', output: event.output as RagOutput });
        else if (event.type === 'error') throw new Error(event.error.message);
      }
    }
    return transcript;
  } finally {
    await runtime.dispose();
  }
}
