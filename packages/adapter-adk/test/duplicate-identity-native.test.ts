// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  type BaseAgent,
  BaseLlm,
  type Event,
  InMemoryRunner,
  isFinalResponse,
  LlmAgent,
  type LlmResponse,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import { expect, test } from 'vitest';

/* DA1: Sequential/Loop duplicates share author, branch and invocation; FAIL.
 * Parallel alone separates branches, including reversed arrival.
 * DA4: findAgent resolves the first specialist. Transfer through Sequential
 * wrappers instead repeats the router to the native call limit (prediction false).
 * Native facts only; no galaxie executor or derivation participates here.
 */
class Scripted extends BaseLlm {
  readonly calls: string[];
  readonly delay: boolean;
  constructor(name: string, calls: string[], delay = false) {
    super({ model: name });
    this.calls = calls;
    this.delay = delay;
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    this.calls.push(this.model);
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, 10));
    yield {
      content: {
        role: 'model',
        parts: [
          this.model === 'router'
            ? { functionCall: { name: 'transfer_to_agent', args: { agent_name: 'specialist' } } }
            : { text: this.model },
        ],
      },
      turnComplete: true,
      ...(this.model === 'partial_only' ? { partial: true, turnComplete: false } : {}),
    };
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}

function tree(shape: string, calls: string[], reverse = false): BaseAgent {
  const leaf = (name: string, position: string, delay = false): LlmAgent =>
    new LlmAgent({ name, model: new Scripted(position, calls, delay) });
  const branches = (name: string): SequentialAgent[] =>
    [false, true].map(
      (second) =>
        new SequentialAgent({
          name: second ? 'second' : 'first',
          subAgents: [leaf(name, second ? 'second' : 'first', reverse !== second)],
        }),
    );
  if (shape === 'parallel')
    return new ParallelAgent({ name: 'root', subAgents: branches('worker') });
  if (shape === 'loop')
    return new LoopAgent({ name: 'root', maxIterations: 2, subAgents: branches('worker') });
  if (shape === 'transfer')
    return new LlmAgent({
      name: 'root',
      model: new Scripted('router', calls),
      subAgents: branches('specialist'),
    });
  return new SequentialAgent({ name: 'root', subAgents: branches('worker') });
}

async function collect(root: BaseAgent): Promise<Event[]> {
  const runner = new InMemoryRunner({ agent: root, appName: 'identity' });
  const session = await runner.sessionService.createSession({
    appName: 'identity',
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  }))
    events.push(event);
  return events.filter((event) => event.content?.role === 'model');
}

for (const [shape, expected] of [
  [
    'sequential',
    [
      ['worker', '', false, true],
      ['worker', '', false, true],
    ],
  ],
  [
    'parallel',
    [
      ['worker', 'root.first', false, true],
      ['worker', 'root.second', false, true],
    ],
  ],
  ['loop', Array.from({ length: 4 }, () => ['worker', '', false, true])],
] as const) {
  test(`native duplicate ${shape} identity fields`, async () => {
    const events = await collect(tree(shape, []));
    expect(
      events
        .map((event) => [
          event.author,
          event.branch ?? '',
          event.partial ?? false,
          isFinalResponse(event),
        ])
        .sort(),
    ).toEqual([...expected].sort());
    expect(new Set(events.map((event) => event.invocationId)).size).toBe(1);
    expect(events.map((event) => event.nodeInfo?.path ?? '')).toEqual(events.map(() => ''));
  });
}

test('native duplicate Parallel branches survive reversed arrival', async () => {
  const runs = await Promise.all(
    [false, true].map(async (reverse) => {
      const calls: string[] = [];
      const events = await collect(tree('parallel', calls, reverse));
      return events.map((event) => [event.content?.parts?.[0]?.text, event.branch]);
    }),
  );
  expect(runs).toEqual([
    [
      ['first', 'root.first'],
      ['second', 'root.second'],
    ],
    [
      ['second', 'root.second'],
      ['first', 'root.first'],
    ],
  ]);
});

test('native transfer through Sequential wrappers never reaches either specialist', async () => {
  const calls: string[] = [];
  const root = tree('transfer', calls);
  const events = await collect(root);
  expect(calls).toHaveLength(500);
  expect(new Set(calls)).toEqual(new Set(['router']));
  expect(new Set(events.map((event) => event.author))).toEqual(new Set(['root']));
  expect(events.every((event) => !isFinalResponse(event))).toBe(true);
  expect(root.findAgent('specialist')).toBe(root.subAgents[0]?.subAgents[0]);
});

test('native root-name reuse and exact distinct names are accepted', async () => {
  const same = new SequentialAgent({
    name: 'worker',
    subAgents: [new LlmAgent({ name: 'worker', model: new Scripted('child', []) })],
  });
  expect((await collect(same)).map((event) => event.author)).toEqual(['worker']);
  const names = ['Worker', 'worker', '\u00e9', 'e\u0301'];
  const root = new SequentialAgent({
    name: 'root',
    subAgents: names.map((name) => new LlmAgent({ name, model: new Scripted(name, []) })),
  });
  expect((await collect(root)).map((event) => event.author)).toEqual(names);
});

test('native shared instance cannot have two parents', () => {
  const shared = new LlmAgent({ name: 'worker', model: new Scripted('shared', []) });
  new SequentialAgent({ name: 'first', subAgents: [shared] });
  expect(() => new SequentialAgent({ name: 'second', subAgents: [shared] })).toThrow(/parent/);
});

test('native no-final worker lets the next duplicate sibling complete', async () => {
  const root = new SequentialAgent({
    name: 'root',
    subAgents: ['first', 'second'].map(
      (name) =>
        new SequentialAgent({
          name,
          subAgents: [
            new LlmAgent({
              name: 'worker',
              model: new Scripted(name === 'first' ? 'partial_only' : 'second', []),
            }),
          ],
        }),
    ),
  });
  const events = await collect(root);
  expect(
    events.map((event) => [event.author, event.partial ?? false, isFinalResponse(event)]),
  ).toEqual([
    ['worker', true, false],
    ['worker', false, true],
  ]);
});
