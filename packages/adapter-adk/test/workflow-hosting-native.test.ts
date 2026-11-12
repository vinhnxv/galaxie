// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  BaseLlm,
  type Event,
  FunctionNode,
  FunctionTool,
  InMemoryRunner,
  JoinNode,
  LlmAgent,
  type LlmResponse,
  Workflow,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createHost } from '../src/host.js';
import { validateAgentTree } from '../src/validate.js';
import { FakeChatModel } from './support/fixtures.js';

/* NW1: independent JS facts; NW2: owned Runner accepts a Workflow root.
 * B-js REFUSED: manifest-only admission cannot establish function-node model
 * routing (GW1), as on Python; later support gates are not measured.
 * AL-W: no complete routed-graph parity evidence; partial static recipes
 * are not classified as an alternative for the whole family.
 */
class Scripted extends BaseLlm {
  #calls = 0;
  readonly #write: boolean;
  constructor(name: string, write = false) {
    super({ model: name });
    this.#write = write;
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: [
          this.#write && this.#calls++ === 0
            ? { functionCall: { name: 'write', args: { value: 1 } } }
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
const leaf = (name: string): LlmAgent => new LlmAgent({ name, model: new Scripted(name) });

async function collect(flow: Workflow): Promise<Event[]> {
  const runner = new InMemoryRunner({ agent: flow, appName: 'workflow' });
  const session = await runner.sessionService.createSession({
    appName: 'workflow',
    userId: 'user',
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  }))
    events.push(event);
  return events;
}
const texts = (events: Event[]): string[] =>
  events.flatMap((event) => event.content?.parts?.flatMap((part) => part.text ?? []) ?? []);

test('native Workflow chain and fanout/join run LlmAgent nodes', async () => {
  expect(
    texts(await collect(new Workflow({ name: 'wf', edges: [['START', leaf('a'), leaf('b')]] }))),
  ).toEqual(['a', 'b']);
  const events = await collect(
    new Workflow({
      name: 'wf',
      edges: [['START', leaf('a'), [leaf('b'), leaf('c')], new JoinNode({ name: 'join' })]],
    }),
  );
  expect(texts(events).sort()).toEqual(['a', 'b', 'c']);
  // JS 2.3.0 uses dotted Workflow paths without run IDs in the event path.
  expect(
    events
      .filter((event) => event.content)
      .map((event) => event.nodeInfo?.path)
      .sort(),
  ).toEqual(['wf.a', 'wf.b', 'wf.c']);
});

test('native Workflow route selects one node and a cycle gets distinct visit IDs', async () => {
  const choose = new FunctionNode('choose', (ctx) => {
    ctx.route = 'yes';
    return 'chosen';
  });
  expect(
    texts(
      await collect(
        new Workflow({ name: 'wf', edges: [['START', choose, { yes: leaf('b'), no: leaf('c') }]] }),
      ),
    ),
  ).toEqual(['chosen', 'b']);
  const visits: string[] = [];
  const step = new FunctionNode('step', (ctx) => {
    visits.push(`${ctx.nodePath}@${ctx.runId}`);
    ctx.route = visits.length === 1 ? 'again' : 'stop';
    return 'visited';
  });
  await collect(
    new Workflow({
      name: 'wf',
      edges: [
        ['START', step],
        [step, { again: step }],
      ],
    }),
  );
  expect(visits).toEqual(['wf.step@1', 'wf.step@2']);
});

test('native local retry reuses its visit ID', async () => {
  const attempts: string[] = [];
  const step = new FunctionNode(
    'retry',
    (ctx) => {
      attempts.push(`${ctx.nodePath}@${ctx.runId}`);
      if (attempts.length === 1) throw new Error('Scripted first attempt.');
      return 'retried';
    },
    { retryConfig: { maxAttempts: 2, initialDelay: 0, jitter: 0 } },
  );
  await collect(new Workflow({ name: 'wf', edges: [['START', step]] }));
  expect(attempts).toEqual(['wf.retry@1', 'wf.retry@1']);
});

test('native Workflow writes once and confirmation stops before the body', async () => {
  for (const pause of [false, true]) {
    const bodies: number[] = [];
    const writer = new LlmAgent({
      name: 'writer',
      model: new Scripted('writer', true),
      tools: [
        new FunctionTool({
          name: 'write',
          description: 'Write.',
          parameters: z.object({ value: z.number() }),
          requireConfirmation: pause,
          execute: async ({ value }) => {
            bodies.push(value);
            return { value };
          },
        }),
      ],
    });
    const events = await collect(new Workflow({ name: 'wf', edges: [['START', writer]] }));
    expect(bodies).toEqual(pause ? [] : [1]);
    if (pause)
      expect(
        events
          .flatMap((event) => event.content?.parts ?? [])
          .some((part) => part.functionCall?.name === 'adk_request_confirmation'),
      ).toBe(true);
  }
});

test('a declared function can dispatch an unlisted model while shipped prepare refuses Workflow', async () => {
  let calls = 0;
  const hidden = new Scripted('hidden');
  const step = new FunctionNode('declared', async () => {
    for await (const _ of hidden.generateContentAsync()) calls++;
    return 'done';
  });
  const flow = new Workflow({ name: 'wf', edges: [['START', step]] });
  await collect(flow);
  expect(calls).toBe(1);
  const { registry } = createHost(
    {
      chatModels: {
        mock: new FakeChatModel(() => {
          throw new Error('unused');
        }),
      },
    },
    { roles: ['agent'], providers: { mock: { credential: false } } },
    () => undefined,
    () => 'conversation',
  );
  expect(() => validateAgentTree(flow, registry)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});
