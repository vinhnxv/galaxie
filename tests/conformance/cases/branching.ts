// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import type { ModelScript } from '../support/scripted-chat-model.js';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const input: { route: string } = { route: 'both' };
export const script: ModelScript = {};

export function factory(
  langgraph: LangGraphModule,
  _model: BaseChatModel,
  checkpointer: BaseCheckpointSaver,
): ConformanceGraph {
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({
    route: Annotation<string>,
    visits: Annotation<string[]>({
      reducer: (left, right) => left.concat(right),
      default: () => [],
    }),
  });
  return new StateGraph(state)
    .addNode('left', () => ({ visits: ['left'] }))
    .addNode('right', () => ({ visits: ['right'] }))
    .addConditionalEdges(START, ({ route }) => (route === 'both' ? ['left', 'right'] : ['left']))
    .addEdge('left', END)
    .addEdge('right', END)
    .compile({ checkpointer });
}
