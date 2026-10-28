// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import type { ModelScript } from '../support/scripted-chat-model.js';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const input: { value: number } = { value: 3 };
export const script: ModelScript = {};

export function factory(
  langgraph: LangGraphModule,
  _model: BaseChatModel,
  checkpointer: BaseCheckpointSaver,
): ConformanceGraph {
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({ value: Annotation<number> });
  const child = new StateGraph(state)
    .addNode('increment', ({ value }) => ({ value: value + 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile();
  return new StateGraph(state)
    .addNode('child', child)
    .addEdge(START, 'child')
    .addEdge('child', END)
    .compile({ checkpointer });
}
