// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { LangGraphAgent } from '@galaxie/adapter-langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { citeAnswer } from './citations.js';
import { systemPrompt, userPrompt } from './prompt.js';
import type { Citation, SearchMode, SearchResult } from './schemas.js';

const input = Annotation.Root({ question: Annotation<string>, mode: Annotation<SearchMode> });
const output = Annotation.Root({ answer: Annotation<string>, citations: Annotation<Citation[]> });
const state = Annotation.Root({
  ...input.spec,
  ...output.spec,
  passages: Annotation<SearchResult['passages']>,
});

export function createRagAgent(): LangGraphAgent {
  return (host) => {
    const model = host.langchain.chatModel('rag.answer');
    const graph = new StateGraph(state, { input, output })
      .addNode(
        'retrieve',
        async ({ question, mode }, config) =>
          (await host.capabilities.call(
            'docs.search@1',
            { query: question, mode, k: 10 },
            config,
          )) as SearchResult,
      )
      .addNode('generateAnswer', async ({ question, passages }, config) => {
        const reply = await model.invoke(
          [new SystemMessage(systemPrompt), new HumanMessage(userPrompt(question, passages))],
          config,
        );
        return citeAnswer(reply.text, passages);
      })
      .addEdge(START, 'retrieve')
      .addEdge('retrieve', 'generateAnswer')
      .addEdge('generateAnswer', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
    return graph.withConfig({ outputKeys: ['answer', 'citations'] });
  };
}
