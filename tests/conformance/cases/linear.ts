// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import type { ModelScript } from '../support/scripted-chat-model.js';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const input: { value: number } = { value: 2 };
export const script: ModelScript = {
  'linear request': {
    id: 'reply-linear',
    text: 'linear response',
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
  },
};

export function factory(
  langgraph: LangGraphModule,
  model: BaseChatModel,
  checkpointer: BaseCheckpointSaver,
): ConformanceGraph {
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({ value: Annotation<number>, answer: Annotation<string> });
  return new StateGraph(state)
    .addNode('respond', async ({ value }, config) => {
      config.writer?.({ phase: 'respond', value });
      const answer = await model.invoke(
        [new HumanMessage({ id: 'human-linear', content: 'linear request' })],
        config,
      );
      return { value: value + 1, answer: answer.content };
    })
    .addNode('double', ({ value }) => ({ value: value * 2 }))
    .addEdge(START, 'respond')
    .addEdge('respond', 'double')
    .addEdge('double', END)
    .compile({ checkpointer });
}
