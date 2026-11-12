// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
} from '@galaxie-ai/core';
import { type BaseAgent, LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkHost } from '../src/host.js';
import { FakeChatModel, wordChunks } from './support/fixtures.js';

/* A-js ALTERNATIVE: GA3 fails on a tree that still prepares today.
 * GA1/GA2/GA4-GA8 are not measured: outcome fixed by GA3.
 * AL1 uses real host-visible messages for all five unique-name trees.
 * AL2 changes no API/bridge/record; AL3 limits are in the README.
 * C-js ALTERNATIVE by GF2; the descriptor remains false in both lanes.
 * Duplicate refusal now supersedes GA3; see duplicate-identity-measure.test.ts.
 */
const definition = defineAgentDefinition({
  id: 'tests/adk-stream-namespaces',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});
const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['streaming', 'tool-calling'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};

function tree(shape: string, host: AdkHost): BaseAgent {
  const leaf = (name: string): LlmAgent =>
    new LlmAgent({ name, model: host.adk.llm('agent'), instruction: `tag:${name}` });
  switch (shape) {
    case 'sequential':
      return new SequentialAgent({ name: 'root', subAgents: [leaf('drafter'), leaf('reviewer')] });
    case 'parallel':
      return new ParallelAgent({ name: 'root', subAgents: [leaf('left'), leaf('right')] });
    case 'nested':
      return new ParallelAgent({
        name: 'root',
        subAgents: [
          new SequentialAgent({ name: 'sequence', subAgents: [leaf('a'), leaf('b')] }),
          leaf('c'),
        ],
      });
    case 'loop':
      return new LoopAgent({ name: 'root', maxIterations: 2, subAgents: [leaf('worker')] });
    case 'transfer':
      return new LlmAgent({
        name: 'root',
        model: host.adk.llm('agent'),
        instruction: 'tag:root',
        subAgents: [leaf('specialist')],
      });
    case 'duplicate':
      return new SequentialAgent({
        name: 'root',
        subAgents: ['first', 'second'].map(
          (name) => new SequentialAgent({ name, subAgents: [leaf('worker')] }),
        ),
      });
    default:
      throw new Error('Unknown tree.');
  }
}

async function measure(shape: string) {
  const model = new FakeChatModel(
    (seen) => {
      const tag = /tag:(\w+)/.exec(seen.messages[0]?.text ?? '')?.[1];
      if (!tag) throw new Error('Missing scripted author.');
      return new AIMessage(
        tag === 'root'
          ? {
              content: '',
              tool_calls: [
                { id: 'transfer', name: 'transfer_to_agent', args: { agent_name: 'specialist' } },
              ],
            }
          : { content: tag },
      );
    },
    undefined,
    wordChunks,
  );
  const runtime = createRuntime({
    appId: 'adk-stream-namespaces',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 10, tokens: 10000 },
  });
  let root: BaseAgent | undefined;
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'user',
      services: { chatModels: { mock: model } },
      models: routing,
      agent: (host: AdkHost) => {
        root = tree(shape, host);
        return root;
      },
    });
    await instance.prepare();
    const { runId } = await instance.start({ prompt: 'go' });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) events.push(event);
    expect(events.at(-1)?.type).toBe('output');
    expect(createAdkAdapter().features.subgraphs).toBe(false);
    const paths = new Map<string, string[][]>();
    const visit = (agent: BaseAgent, path: string[]): void => {
      paths.set(agent.name, [...(paths.get(agent.name) ?? []), path]);
      for (const child of agent.subAgents) visit(child, [...path, child.name]);
    };
    if (!root) throw new Error('Factory did not run.');
    visit(root, []);
    const messages = events.flatMap((event) =>
      event.type === 'stream' && event.mode === 'messages' ? [event] : [],
    );
    for (const event of messages) expect(event.path).toEqual([]);
    return { paths, messages };
  } catch (error) {
    if (shape === 'duplicate') expect(model.seen).toEqual([]);
    throw error;
  } finally {
    await runtime.dispose();
  }
}

for (const [shape, expected] of [
  ['sequential', [['drafter'], ['reviewer']]],
  ['parallel', [['left'], ['right']]],
  ['nested', [['sequence', 'a'], ['sequence', 'b'], ['c']]],
  ['loop', [['worker'], ['worker']]],
  ['transfer', [['specialist']]],
] as const) {
  test(`host author recipe attributes ${shape} messages to the tree oracle`, async () => {
    const { paths, messages } = await measure(shape);
    const actual = messages.map((event) => {
      const author = (event.data as { author: string }).author;
      expect(paths.get(author)).toHaveLength(1);
      return paths.get(author)?.[0];
    });
    expect(actual.sort()).toEqual([...expected].sort());
  });
}

test('duplicate leaves fail unsupported at prepare before any model call', async () => {
  await expect(measure('duplicate')).rejects.toMatchObject({ code: 'unsupported' });
});
