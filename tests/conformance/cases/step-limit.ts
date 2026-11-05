// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import type { ModelScript } from '../support/scripted-chat-model.js';
import type { ConformanceGraph, LangGraphModule } from '../support/transcript.js';

export const input: { value: number } = { value: 0 };
export const script: ModelScript = {};
export function factory(
  langgraph: LangGraphModule,
  _model: BaseChatModel,
  checkpointer: BaseCheckpointSaver,
): ConformanceGraph {
  const { Annotation, StateGraph, START } = langgraph;
  const state = Annotation.Root({ value: Annotation<number> });
  return new StateGraph(state)
    .addNode('loop', ({ value }) => ({ value: value + 1 }))
    .addEdge(START, 'loop')
    .addEdge('loop', 'loop')
    .compile({ checkpointer });
}
