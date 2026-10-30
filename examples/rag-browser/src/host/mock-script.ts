// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { MockChatModel } from '@galaxie/models/mock';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import fixture from '../../test/fixtures/corpus.json' with { type: 'json' };
import { type Corpus, parseCorpus } from '../corpus.js';
import { localDescriptor, type RagModels } from './runtime.js';

export const mockCorpus: Corpus = parseCorpus(fixture);
function script(messages: BaseMessage[]): MockChatModel {
  const human = messages.findLast((message) => message.type === 'human')?.text ?? '';
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
  constructor() {
    super({});
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    return script(messages)._generate(messages, options);
  }
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* script(messages)._streamResponseChunks(messages, options);
  }
}
export function createMockModels(): RagModels {
  return {
    chatModels: { mock: new RagMockModel() },
    routing: {
      providers: { mock: localDescriptor },
      roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 1500 } },
    },
  };
}
