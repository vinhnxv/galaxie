// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { type AgentInstance, createRuntime, type ModelRouting, type RunEvent } from '@galaxie/core';
import { ragDefinition } from '../../src/agent/definition.js';
import { createRagAgent } from '../../src/agent/graph.js';
import type { RagInput, RagOutput } from '../../src/agent/schemas.js';
import { reviewRegistry } from '../../src/host/review-passages.js';
import { answerDelta } from '../../src/host/stream.js';
import {
  assertTranscript,
  createTranscriptReplay,
  goldenTranscript,
  type ParityScript,
  parityScript,
  type TranscriptEntry,
} from './transcript.js';

const first = parityScript.session[0];
const [capability, model, output] = goldenTranscript;
if (!first || !capability || !model || !output)
  throw new Error('The review fixture is incomplete.');
const reviewInput: RagInput = { ...first.input, review: true };
export const reviewScript: ParityScript = {
  corpus: parityScript.corpus,
  session: [
    {
      ...first,
      input: reviewInput,
      search: {
        passages: [
          { id: 'dropped', title: 'Dropped title', text: 'Dropped private passage.', score: 10 },
          ...first.search.passages,
        ],
      },
    },
  ],
};
export const reviewExpected: readonly TranscriptEntry[] = [
  capability,
  {
    type: 'interaction',
    component: 'rag.ReviewPassages/v1',
    props: {
      passages: [
        { id: 'dropped', title: 'Dropped title' },
        { id: 'paris', title: 'France' },
      ],
    },
  },
  model,
  output,
];
export const reviewRouting: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      features: ['streaming'],
      languages: ['en'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 500 } },
};
export function reviewReplay(
  transcript: TranscriptEntry[],
): ReturnType<typeof createTranscriptReplay> {
  return createTranscriptReplay(reviewScript, transcript);
}
export async function replayJavaScriptReview(): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const replay = reviewReplay(transcript);
  const runtime = createRuntime({
    appId: 'rag-review-parity',
    executors: [createLangGraphAdapter()],
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(ragDefinition, {
      principalScope: 'fixture',
      agent: createRagAgent(),
      services: { chatModels: { mock: replay.model } },
      models: reviewRouting,
      bindings: {
        'docs.search@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 5000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: replay.search,
        },
      },
      ui: reviewRegistry.bindings({ surfaces: ['rag-review'] }),
    });
    await instance.prepare();
    const stream = await recordReview(instance, transcript);
    if (!stream.subgraph || stream.text !== 'Paris is the capital [1]. [9]')
      throw new Error('The review stream differs.');
    return transcript;
  } finally {
    await runtime.dispose();
  }
}
export async function recordReview(
  instance: AgentInstance<RagInput, unknown>,
  transcript: TranscriptEntry[],
): Promise<{ subgraph: boolean; text: string }> {
  const { runId } = await instance.start(reviewInput);
  let subgraph = false;
  for await (const event of instance.events(runId)) {
    if (event.type === 'error') throw new Error(event.error.message);
    if (event.type === 'stream' && event.path.some((value) => value.startsWith('retrieval:')))
      subgraph = true;
    if (event.type === 'interaction') {
      transcript.push({
        type: 'interaction',
        component: event.interaction.component,
        props: event.interaction.props,
      });
      break;
    }
  }
  const pending = instance.getSnapshot().run?.pending;
  if (!pending) throw new Error('The review did not pause.');
  const events: RunEvent[] = [];
  const follow = (async () => {
    for await (const event of instance.events(runId)) events.push(event);
  })();
  const receipt = await instance.dispatch({
    ...pending,
    instanceId: instance.instanceId,
    runId,
    action: 'submit',
    payload: { keptIds: ['paris'] },
  });
  if (receipt.status !== 'accepted') throw new Error('The review was not accepted.');
  await follow;
  const output = events.find((event) => event.type === 'output');
  if (output?.type !== 'output') throw new Error('The review did not complete.');
  transcript.push({ type: 'output', output: output.output as RagOutput });
  assertTranscript(transcript, reviewExpected);
  return { subgraph, text: events.map(answerDelta).join('') };
}
