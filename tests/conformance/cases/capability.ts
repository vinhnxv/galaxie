// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph/web';
import { z } from 'zod';
import type { ModelScript } from '../support/scripted-chat-model.js';
import type {
  ConformanceCase,
  ConformanceGraph,
  ConformanceTools,
  LangGraphModule,
} from '../support/transcript.js';

export const input: { value: number } = { value: 2 };
export const script: ModelScript = {};
export const capabilities: NonNullable<ConformanceCase['capabilities']> = {
  'double@1': {
    input: z.object({ value: z.number() }),
    output: z.object({ value: z.number() }),
    kind: 'read',
    invoke: async (input) => ({ value: (input as { value: number }).value * 2 }),
  },
};
export function factory(
  langgraph: LangGraphModule,
  _model: BaseChatModel,
  checkpointer: BaseCheckpointSaver,
  tools?: ConformanceTools,
): ConformanceGraph {
  if (tools === undefined) throw new Error('The capability fixture needs its tool port.');
  const { Annotation, StateGraph, START, END } = langgraph;
  const state = Annotation.Root({ value: Annotation<number> });
  return new StateGraph(state)
    .addNode('double', async ({ value }, config) => {
      return (await tools.call('double@1', { value }, config)) as { value: number };
    })
    .addEdge(START, 'double')
    .addEdge('double', END)
    .compile({ checkpointer });
}
