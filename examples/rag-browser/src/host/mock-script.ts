// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { MockChatModel, type MockScriptEntry } from '@galaxie/models/mock';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import fixture from '../../test/fixtures/corpus.json' with { type: 'json' };
import { type Corpus, parseCorpus } from '../corpus.js';
import { localDescriptor, type RagModels } from './runtime.js';

export const mockCorpus: Corpus = parseCorpus(fixture);
function script(messages: BaseMessage[], tools: BindToolsInput[]): MockChatModel {
  const human = messages.findLast((message) => message.type === 'human')?.text ?? '';
  if (tools.length > 0) {
    const input = JSON.parse(human) as { question: string; mode: string; review?: boolean };
    const result = messages.findLast((message) => message.type === 'tool')?.text;
    const passages = result
      ? (JSON.parse(result) as { passages: { text: string }[] }).passages
      : [];
    const selected = input.review ? passages : passages.slice(0, 1);
    const answer = selected.length
      ? selected.map((passage, index) => `${passage.text} [${index + 1}]`).join(' ')
      : 'No passages support an answer.';
    const sequence: MockScriptEntry[] = [
      {
        id: 'rag-search',
        text: '',
        toolCalls: [
          {
            id: 'rag-search-call',
            name: 'search_docs',
            args: { query: input.question, mode: input.mode, k: 10 },
          },
        ],
      },
    ];
    if (input.review)
      sequence.push({
        id: 'rag-review',
        text: '',
        toolCalls: [{ id: 'rag-review-call', name: 'review_passages', args: {} }],
      });
    sequence.push({
      id: 'rag-answer',
      text:
        input.question === 'Show an answer without citations.'
          ? 'This mock answer has no citation.'
          : answer,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    return new MockChatModel({ [human]: sequence }).bindTools(tools);
  }
  const data = human.split('BEGIN_REFERENCE_DATA\n')[1]?.split('\nEND_REFERENCE_DATA')[0] ?? '[]';
  const passages = JSON.parse(data) as { text: string }[];
  const text = human.startsWith('Question: Show an answer without citations.')
    ? 'This mock answer has no citation.'
    : passages[0]
      ? `${passages[0].text} [1]`
      : 'No passages support an answer.';
  return new MockChatModel({
    [human]: {
      id: 'rag-mock-answer',
      text,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
}
class RagMockModel extends MockChatModel {
  private readonly tools: BindToolsInput[];
  constructor(tools: BindToolsInput[] = []) {
    super({});
    this.tools = tools;
  }
  override bindTools(tools: BindToolsInput[]): RagMockModel {
    return new RagMockModel(tools);
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    return script(messages, this.tools)._generate(messages, options);
  }
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatGenerationChunk> {
    for await (const chunk of script(messages, this.tools)._streamResponseChunks(
      messages,
      options,
    )) {
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      yield chunk;
    }
  }
}
export function createMockModels(): RagModels {
  return {
    chatModels: { mock: new RagMockModel() },
    routing: {
      providers: {
        mock: { ...localDescriptor, features: [...localDescriptor.features, 'tool-calling'] },
      },
      roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 1500 } },
    },
  };
}
