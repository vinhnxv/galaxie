// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type LangGraphAgent, requestInteraction } from '@galaxie/adapter-langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { citeAnswer } from './citations.js';
import { systemPrompt, userPrompt } from './prompt.js';
import {
  type Citation,
  ReviewSubmissionSchema,
  type SearchMode,
  type SearchResult,
  type Source,
} from './schemas.js';

const input = Annotation.Root({
  question: Annotation<string>,
  mode: Annotation<SearchMode>,
  review: Annotation<boolean | undefined>,
});
const output = Annotation.Root({
  answer: Annotation<string>,
  citations: Annotation<Citation[]>,
  sources: Annotation<Source[]>,
});
const state = Annotation.Root({
  ...input.spec,
  ...output.spec,
  passages: Annotation<SearchResult['passages']>,
});

export function createRagAgent(): LangGraphAgent {
  return (host) => {
    const model = host.langchain.chatModel('rag.answer');
    const retrieve = async (
      { question, mode }: typeof state.State,
      config: Parameters<typeof host.capabilities.call>[2],
    ): Promise<SearchResult> =>
      (await host.capabilities.call(
        'docs.search@1',
        { query: question, mode, k: 10 },
        config,
      )) as SearchResult;
    const retrieval = new StateGraph(state)
      .addNode('retrieve', retrieve)
      .addEdge(START, 'retrieve')
      .addEdge('retrieve', END)
      .compile();
    const graph = new StateGraph(state, { input, output })
      .addNode('retrieve', retrieve)
      .addNode('retrieval', retrieval)
      .addNode('reviewPassages', ({ passages }, config) => {
        const submission = requestInteraction(
          {
            surfaceId: 'rag-review',
            component: 'rag.ReviewPassages/v1',
            viewRevision: 'review-v1',
            props: { passages: passages.map(({ id, title }) => ({ id, title })) },
          },
          config,
        );
        const { keptIds } = ReviewSubmissionSchema.parse(submission.payload);
        return { passages: passages.filter(({ id }) => keptIds.includes(id)) };
      })
      .addNode('generateAnswer', async ({ question, passages }, config) => {
        const reply = await model.invoke(
          [new SystemMessage(systemPrompt), new HumanMessage(userPrompt(question, passages))],
          config,
        );
        return citeAnswer(reply.text, passages);
      })
      .addConditionalEdges(START, ({ review }) => (review ? 'retrieval' : 'retrieve'), [
        'retrieval',
        'retrieve',
      ])
      .addEdge('retrieval', 'reviewPassages')
      .addEdge('reviewPassages', 'generateAnswer')
      .addEdge('retrieve', 'generateAnswer')
      .addEdge('generateAnswer', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
    return graph.withConfig({ outputKeys: ['answer', 'citations', 'sources'] });
  };
}
