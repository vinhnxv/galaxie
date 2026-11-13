// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  type BaseAgent,
  BaseLlm,
  type Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoopAgent,
  SequentialAgent,
  StreamingMode,
  setLogger,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';

/* Native ADK 2.3.0, scripted models, Node and Chromium.
 * Shape             N1 continuity   N2 bodies once   N3 prior persistent state
 * L6, L7, L9        PASS            PASS             PASS
 * L8                PASS            PASS             NA: no prior state
 * transfer-last     PASS            PASS             PASS
 * loop-before-last  PASS            PASS             NA: no prior state
 * Literal request orders (uninterrupted = resumability on):
 * L6: a b c d d; L7/L9: a b b; L8: writer writer b b;
 * transfer-last: a parent child child; loop-before-last: w w b b.
 * Resumability off restarts earlier leaves; its exact orders are pinned below.
 * Temporary session seed is absent from every request (informational).
 * No workflow agentState, endOfAgent or nodeInfo is emitted; branches are absent.
 * L1-L5 reuse workflow-resume-native.test.ts: W4, W4-deny, W4-nested,
 * W4-twice and W7-last (nested order a b c c; deny executes zero bodies).
 * Both extra controls remain excluded by ADR-0020's registered tree predicate,
 * despite their native continuity; native parity alone cannot admit them.
 * L8's writer is an ordinary native body: host confirmation is measured in the
 * galaxie lane, while only b raises an ADK confirmation here.
 * The registered rule is in ADR-0020, "Last-child rerun"; fresh P1 orders hold.
 */

type Tree = string | { seq: Tree[] } | { loop: Tree[] } | { transfer: Tree };
interface Shape {
  id: string;
  tree: Tree;
  paused: string[];
  twoCalls?: boolean;
}
const shapes: Shape[] = [
  { id: 'L6', tree: { seq: ['a', { seq: ['b', { seq: ['c', 'd'] }] }] }, paused: ['d'] },
  { id: 'L7', tree: { seq: ['a', 'b'] }, paused: ['b'], twoCalls: true },
  { id: 'L8', tree: { seq: ['writer', 'b'] }, paused: ['b'] },
  { id: 'L9', tree: { seq: ['a', 'b'] }, paused: ['b'] },
  { id: 'transfer-last', tree: { seq: ['a', { transfer: 'child' }] }, paused: ['child'] },
  { id: 'loop-before-last', tree: { seq: [{ loop: ['w'] }, 'b'] }, paused: ['b'] },
];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
setLogger({ debug() {}, info() {}, warn() {}, error() {}, log() {}, setLogLevel() {} });

interface Observation {
  requests: string[];
  tools: string[];
  branches: (string | undefined)[];
  states: { tag: string; persistent: boolean; temporary: boolean }[];
  events: Event[];
  pauses: { author: string | undefined; requests: string[]; tools: string[]; calls: number }[];
  answers: number[];
  late: string[];
  error?: string;
}

// Adapted from workflow-resume-native.test.ts; no galaxie adapter participates.
async function measure(
  shape: Shape,
  resumable: boolean,
  uninterrupted = false,
): Promise<Observation> {
  const seen: Observation = {
    requests: [],
    tools: [],
    branches: [],
    states: [],
    events: [],
    pauses: [],
    answers: [],
    late: [],
  };
  let stopped = false;
  let serial = 0;
  const turns = new Map<string, number>();
  class Scripted extends BaseLlm {
    readonly tag: string;
    constructor(tag: string) {
      super({ model: 'scripted' });
      this.tag = tag;
    }
    override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
      const tag = this.tag;
      seen.requests.push(tag);
      if (stopped) seen.late.push(`model:${tag}`);
      const system = String(request.config?.systemInstruction ?? '');
      seen.states.push({
        tag,
        persistent: system.includes('persistent=value-a'),
        temporary: system.includes('temporary=temporary-a'),
      });
      const turn = turns.get(tag) ?? 0;
      turns.set(tag, turn + 1);
      const calls =
        tag === 'parent'
          ? [{ name: 'transfer_to_agent', args: { agent_name: 'child' } }]
          : (shape.paused.includes(tag) && turn === 0) || (tag === 'writer' && turn % 2 === 0)
            ? (shape.twoCalls && tag === 'b' ? [0, 1] : [0]).map((index) => ({
                name: `save_${tag}_${index}`,
                args: { q: tag },
              }))
            : [];
      yield {
        content: {
          role: 'model',
          parts:
            calls.length > 0
              ? calls.map((functionCall) => ({ functionCall }))
              : [{ text: tag === 'a' ? 'value-a' : `${tag}:done` }],
        },
        turnComplete: true,
      };
    }
    override async connect(): Promise<never> {
      throw new Error('Scripted models have no live connection.');
    }
  }
  const build = (tree: Tree): BaseAgent => {
    if (typeof tree !== 'string') {
      const name = `flow_${serial++}`;
      if ('seq' in tree) return new SequentialAgent({ name, subAgents: tree.seq.map(build) });
      if ('loop' in tree)
        return new LoopAgent({ name, maxIterations: 2, subAgents: tree.loop.map(build) });
      return new LlmAgent({
        name: 'parent',
        model: new Scripted('parent'),
        subAgents: [build(tree.transfer)],
      });
    }
    const tools = (shape.twoCalls && tree === 'b' ? [0, 1] : [0]).map(
      (index) =>
        new FunctionTool({
          name: `save_${tree}_${index}`,
          description: 'Record one scripted write.',
          parameters: z.object({ q: z.string() }),
          ...(shape.paused.includes(tree) && !uninterrupted ? { requireConfirmation: true } : {}),
          execute: async (_input: { q: string }, context) => {
            seen.tools.push(`${tree}:${index}`);
            seen.branches.push(context?.invocationContext.branch);
            if (stopped) seen.late.push(`tool:${tree}:${index}`);
            return { saved: tree };
          },
        }),
    );
    return new LlmAgent({
      name: tree,
      model: new Scripted(tree),
      tools,
      instruction: `role=${tree}; persistent={saved?}; temporary={temp:saved?}`,
      ...(tree === 'a' ? { outputKey: 'saved' } : {}),
    });
  };
  const runner = new InMemoryRunner({
    agent: build(shape.tree),
    appName: 'last-child-native',
    ...(resumable ? { resumabilityConfig: { isResumable: true } } : {}),
  });
  const session = await runner.sessionService.createSession({
    appName: 'last-child-native',
    userId: 'u',
    state: { 'temp:saved': 'temporary-a' },
  });
  type Message = NonNullable<Parameters<typeof runner.runAsync>[0]['newMessage']>;
  const segment = async (newMessage: Message): Promise<Event | undefined> => {
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage,
      runConfig: { streamingMode: StreamingMode.SSE, pauseOnToolCalls: false },
    })) {
      seen.events.push(event);
      const calls = (event.content?.parts ?? []).filter(
        (part) => part.functionCall?.name === 'adk_request_confirmation',
      );
      if (calls.length > 0 && !uninterrupted) {
        seen.pauses.push({
          author: event.author,
          requests: [...seen.requests],
          tools: [...seen.tools],
          calls: calls.length,
        });
        stopped = true;
        return event;
      }
    }
    return undefined;
  };
  let pending = await segment({ role: 'user', parts: [{ text: 'go' }] });
  for (let i = 0; pending !== undefined && i < 3; i++) {
    await delay(40); // Drain work after stopping the consumer, as in the existing native probe.
    stopped = false;
    const calls = (pending.content?.parts ?? []).flatMap((part) =>
      part.functionCall?.name === 'adk_request_confirmation' ? [part.functionCall] : [],
    );
    if (calls.length === 0) throw new Error('Missing native confirmation calls.');
    seen.answers.push(calls.length);
    try {
      pending = await segment({
        role: 'user',
        // Both native confirmation responses share one message, equivalent to indexes [0, 1].
        parts: calls.map((call) => {
          if (call.id === undefined || call.name === undefined)
            throw new Error('Missing native confirmation identity.');
          return {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { confirmed: true },
            },
          };
        }),
      });
    } catch (error) {
      seen.error =
        error instanceof Error ? error.message.replace(/adk-[a-f0-9-]+/g, '<call>') : String(error);
      break;
    }
  }
  await delay(40);
  return seen;
}

const expected: Record<
  string,
  { full: string; off: string; tools: string[]; priorState: boolean }
> = {
  L6: { full: 'a b c d d', off: 'a b c d a b c d', tools: ['d:0'], priorState: true },
  L7: { full: 'a b b', off: 'a b a b', tools: ['b:0', 'b:1'], priorState: true },
  L8: {
    full: 'writer writer b b',
    off: 'writer writer b writer writer b',
    tools: ['writer:0', 'b:0'],
    priorState: false,
  },
  L9: { full: 'a b b', off: 'a b a b', tools: ['b:0'], priorState: true },
  'transfer-last': {
    full: 'a parent child child',
    off: 'a parent child a parent child',
    tools: ['child:0'],
    priorState: true,
  },
  'loop-before-last': {
    full: 'w w b b',
    off: 'w w b w w b',
    tools: ['b:0'],
    priorState: false,
  },
};

test.each(shapes)('$id measures native resumability off, on and uninterrupted', async (shape) => {
  const full = await measure(shape, false, true);
  const off = await measure(shape, false);
  const on = await measure(shape, true);
  const row = expected[shape.id];
  if (row === undefined) throw new Error('Missing native last-child row.');
  expect(full.requests.join(' ')).toBe(row.full);
  expect(on.requests).toEqual(full.requests);
  expect(off.requests.join(' ')).toBe(row.off);
  expect(full.tools).toEqual(row.tools);
  expect(on.tools).toEqual(row.tools);
  expect(off.tools).toEqual(shape.id === 'L8' ? ['writer:0', 'writer:0', 'b:0'] : row.tools);
  expect(full.pauses).toEqual([]);
  expect(full.answers).toEqual([]);
  for (const lane of [off, on]) {
    expect(lane.pauses).toEqual([
      {
        author: shape.paused[0],
        requests: full.requests.slice(0, -1),
        tools: shape.id === 'L8' ? ['writer:0'] : [],
        calls: shape.twoCalls ? 2 : 1,
      },
    ]);
    // A two-call turn is answered by two native function responses in one message.
    expect(lane.answers).toEqual([shape.twoCalls ? 2 : 1]);
  }
  for (const lane of [full, off, on]) {
    expect(lane.error).toBeUndefined();
    expect(lane.late).toEqual([]);
    expect(lane.branches).toEqual(lane.tools.map(() => undefined));
    expect(
      lane.events.every(
        (event) =>
          event.actions?.agentState === undefined &&
          event.actions?.endOfAgent === undefined &&
          event.nodeInfo === undefined,
      ),
    ).toBe(true);
    expect(lane.states.every((state) => !state.temporary)).toBe(true);
    if (row.priorState) expect(lane.states.at(-1)?.persistent).toBe(true);
  }
  if (shape.id === 'L9')
    expect(on.states.filter((state) => state.tag === 'b')).toEqual([
      { tag: 'b', persistent: true, temporary: false },
      { tag: 'b', persistent: true, temporary: false },
    ]);
});
