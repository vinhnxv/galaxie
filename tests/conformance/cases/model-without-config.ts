// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import type { ModelScript } from '../support/scripted-chat-model.js';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const input: { value: number } = { value: 1 };
export const script: ModelScript = {
  'implicit request': {
    id: 'reply-implicit',
    text: 'implicit response',
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
    .addNode('implicit', async () => ({
      answer: (
        await model.invoke([
          new HumanMessage({ id: 'human-implicit', content: 'implicit request' }),
        ])
      ).content,
    }))
    .addEdge(START, 'implicit')
    .addEdge('implicit', END)
    .compile({ checkpointer });
}
