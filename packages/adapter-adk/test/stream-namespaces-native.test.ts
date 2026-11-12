// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  type BaseAgent,
  BaseLlm,
  InMemoryRunner,
  LlmAgent,
  type LlmResponse,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import { expect, test } from 'vitest';

/* NA1: hand-written tree oracles; NA2: only Parallel forks branches.
 * Duplicate authors are valid and collide even with branch information.
 * No galaxie path projection participates in this native evidence.
 */
class Scripted extends BaseLlm {
  readonly #transfer: boolean;
  readonly #delay: boolean;
  constructor(name: string, transfer = false, delay = false) {
    super({ model: name });
    this.#transfer = transfer;
    this.#delay = delay;
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    if (this.#delay) await new Promise((resolve) => setTimeout(resolve, 10));
    yield {
      content: {
        role: 'model',
        parts: [
          this.#transfer
            ? { functionCall: { name: 'transfer_to_agent', args: { agent_name: 'specialist' } } }
            : { text: this.model },
        ],
      },
      turnComplete: true,
    };
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}

function tree(shape: string, reverse = false): BaseAgent {
  const leaf = (name: string, delay = false): LlmAgent =>
    new LlmAgent({ name, model: new Scripted(name, false, delay) });
  switch (shape) {
    case 'sequential':
      return new SequentialAgent({ name: 'root', subAgents: [leaf('drafter'), leaf('reviewer')] });
    case 'parallel':
      return new ParallelAgent({
        name: 'root',
        subAgents: [leaf('left', reverse), leaf('right', !reverse)],
      });
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
        model: new Scripted('root', true),
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

const oracles: Record<string, Array<[string, string, string[]]>> = {
  sequential: [
    ['drafter', '', ['drafter']],
    ['reviewer', '', ['reviewer']],
  ],
  parallel: [
    ['left', 'root.left', ['left']],
    ['right', 'root.right', ['right']],
  ],
  nested: [
    ['a', 'root.sequence', ['sequence', 'a']],
    ['b', 'root.sequence', ['sequence', 'b']],
    ['c', 'root.c', ['c']],
  ],
  loop: [
    ['worker', '', ['worker']],
    ['worker', '', ['worker']],
  ],
  transfer: [
    ['root', '', []],
    ['specialist', '', ['specialist']],
  ],
  duplicate: [
    ['worker', '', ['first', 'worker']],
    ['worker', '', ['second', 'worker']],
  ],
};

async function collect(agent: BaseAgent) {
  const runner = new InMemoryRunner({ agent, appName: 'identity' });
  const session = await runner.sessionService.createSession({
    appName: 'identity',
    userId: 'user',
  });
  const events = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  }))
    events.push(event);
  return events.filter((event) => event.content?.role === 'model');
}

for (const [shape, oracle] of Object.entries(oracles)) {
  test(`native ${shape} authors and branches match the tree oracle`, async () => {
    const events = await collect(tree(shape));
    expect(events.map((event) => [event.author, event.branch ?? '']).sort()).toEqual(
      oracle.map(([author, branch]) => [author, branch]).sort(),
    );
    expect(events.map((event) => event.nodeInfo?.path ?? '')).toEqual(events.map(() => ''));
    if (shape === 'duplicate') expect(oracle[0]?.[2]).not.toEqual(oracle[1]?.[2]);
  });
}

test('native Parallel arrival reverses without changing branch identity', async () => {
  const runs = await Promise.all(
    [false, true].map((reverse) => collect(tree('parallel', reverse))),
  );
  expect(runs.map((events) => events.map((event) => event.author))).toEqual([
    ['left', 'right'],
    ['right', 'left'],
  ]);
});
