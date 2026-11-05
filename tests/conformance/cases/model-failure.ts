// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import { FixtureModelError, type ModelScript } from '../support/scripted-chat-model.js';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const input: { value: number } = { value: 1 };
export const script: ModelScript = {
  'failure request': { error: new FixtureModelError('The conformance fixture failed.') },
};

export function factory(
  langgraph: LangGraphModule,
  model: BaseChatModel,
  checkpointer: BaseCheckpointSaver,
): ConformanceGraph {
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({ value: Annotation<number>, answer: Annotation<string> });
  return new StateGraph(state)
    .addNode('fail', async (_state, config) => ({
      answer: (
        await model.invoke(
          [new HumanMessage({ id: 'human-failure', content: 'failure request' })],
          config,
        )
      ).content,
    }))
    .addEdge(START, 'fail')
    .addEdge('fail', END)
    .compile({ checkpointer });
}
