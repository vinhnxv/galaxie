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
  LongRunningFunctionTool,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
  StreamingMode,
  setLogger,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';

/* Native gates (Node and Chromium, scripted ADK 2.3.0):
 * Shape                    N1 continuity   N2 paused body once   N3 state
 * W1, W2, W3-first/later    FAIL            PASS                  PASS/NA
 * W4 approve/deny/nested/2  PASS            PASS (deny: zero)     PASS
 * W4-temp                  PASS            PASS                  temp lost
 * W5 worker/writer         FAIL            PASS                  NA: no prior state
 * W6 left/right/last/both   FAIL            PASS except both     PASS/NA
 * W7 last/middle           PASS/FAIL       PASS                 PASS
 * W8 transfer/workflow     PASS/FAIL       PASS                  NA/PASS
 * N3: persistent state survives; temp output is already absent at the next
 * request, including before resume. No workflow progress actions are emitted.
 * W6 left/last: a right-branch body finishes after the consumer stops; resume
 * invokes left with no branch. Both-branch case loses the unanswered right.
 * W7: stop after the pending tool result, matching the adapter cutoff; an
 * external response resumes its author with resumability. Default routing errors.
 */

type Tree = string | { seq: Tree[] } | { loop: Tree[] } | { par: Tree[] } | { transfer: Tree };
interface Shape {
  id: string;
  tree: Tree;
  paused: string[];
  deny?: boolean;
  twice?: boolean;
  long?: boolean;
  rightFirst?: boolean;
  temporary?: boolean;
}
const shapes: Shape[] = [
  { id: 'W1', tree: { seq: ['first', 'second'] }, paused: ['first'] },
  { id: 'W2', tree: { seq: ['a', 'b', 'c'] }, paused: ['b'] },
  { id: 'W3-first', tree: { seq: [{ seq: ['inner', 'b'] }, 'c'] }, paused: ['inner'] },
  { id: 'W3-later', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['b'] },
  { id: 'W4', tree: { seq: ['a', 'b'] }, paused: ['b'] },
  { id: 'W4-deny', tree: { seq: ['a', 'b'] }, paused: ['b'], deny: true },
  { id: 'W4-nested', tree: { seq: ['a', { seq: ['b', 'c'] }] }, paused: ['c'] },
  { id: 'W4-twice', tree: { seq: ['a', 'b'] }, paused: ['b'], twice: true },
  { id: 'W4-temp', tree: { seq: ['a', 'b'] }, paused: ['b'], temporary: true },
  { id: 'W5-worker', tree: { loop: ['worker'] }, paused: ['worker'] },
  { id: 'W5-writer', tree: { loop: ['writer', 'checker'] }, paused: ['checker'] },
  { id: 'W6-left', tree: { seq: [{ par: ['left', 'right'] }, 'merger'] }, paused: ['left'] },
  {
    id: 'W6-right',
    tree: { seq: [{ par: ['left', 'right'] }, 'merger'] },
    paused: ['left'],
    rightFirst: true,
  },
  { id: 'W6-last', tree: { seq: ['a', { par: ['left', 'right'] }] }, paused: ['left'] },
  { id: 'W6-both', tree: { par: ['left', 'right'] }, paused: ['left', 'right'] },
  { id: 'W7-last', tree: { seq: ['a', 'b'] }, paused: ['b'], long: true },
  { id: 'W7-middle', tree: { seq: ['a', 'b', 'c'] }, paused: ['b'], long: true },
  { id: 'W8', tree: { transfer: 'child' }, paused: ['child'] },
  { id: 'W8-workflow', tree: { seq: ['a', { transfer: 'child' }, 'c'] }, paused: ['child'] },
];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { debug() {}, info() {}, warn() {}, error() {}, log() {}, setLogLevel() {} };
setLogger(quiet);

interface Observation {
  requests: string[];
  tools: string[];
  branches: (string | undefined)[];
  states: { tag: string; persistent: unknown; temporary: unknown }[];
  events: Event[];
  pauses: number;
  late: string[];
  error?: string;
}

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
    pauses: 0,
    late: [],
  };
  let stopped = false;
  let serial = 0;
  const turns = new Map<string, number>();
  const rightFinished = Promise.withResolvers<void>();
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
        temporary: system.includes('temporary=value-a'),
      });
      const turn = turns.get(tag) ?? 0;
      turns.set(tag, turn + 1);
      if (shape.rightFirst && tag === 'left' && turn === 0) await rightFinished.promise;
      if (shape.rightFirst && tag === 'right' && turn > 0)
        setTimeout(() => rightFinished.resolve(), 0);
      const call =
        tag === 'parent'
          ? { name: 'transfer_to_agent', args: { agent_name: 'child' } }
          : (shape.paused.includes(tag) && turn < (shape.twice ? 2 : 1)) ||
              (tag === 'writer' && turn % 2 === 0) ||
              (tag === 'right' && turn === 0 && !shape.paused.includes(tag))
            ? { name: `save_${tag}`, args: { q: tag } }
            : undefined;
      yield {
        content: {
          role: 'model',
          parts: [
            call === undefined
              ? { text: tag === 'a' ? 'value-a' : `${tag}:done` }
              : { functionCall: call },
          ],
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
      if ('par' in tree) return new ParallelAgent({ name, subAgents: tree.par.map(build) });
      return new LlmAgent({
        name: 'parent',
        model: new Scripted('parent'),
        subAgents: [build(tree.transfer)],
      });
    }
    const paused = shape.paused.includes(tree);
    const Tool = paused && shape.long && !uninterrupted ? LongRunningFunctionTool : FunctionTool;
    const tool = new Tool({
      name: `save_${tree}`,
      description: 'Record one scripted call.',
      parameters: z.object({ q: z.string() }),
      ...(paused && !shape.long && !uninterrupted ? { requireConfirmation: true } : {}),
      execute: async (_input: { q: string }, context) => {
        if (tree === 'right' && !shape.rightFirst) await delay(30);
        seen.tools.push(tree);
        seen.branches.push(context?.invocationContext.branch);
        if (stopped) seen.late.push(`tool:${tree}`);
        return { saved: tree };
      },
    });
    return new LlmAgent({
      name: tree,
      model: new Scripted(tree),
      tools: [tool],
      instruction: `role=${tree}; persistent={saved?}; temporary={temp:saved?}`,
      ...(tree === 'a' ? { outputKey: 'saved' } : {}),
    });
  };
  const agent = build(shape.tree);
  // A separate temporary writer lets the same scenario inspect both state classes.
  if (shape.temporary) {
    const first = agent.findAgent('a');
    if (first instanceof LlmAgent) first.outputKey = 'temp:saved';
  }
  const runner = new InMemoryRunner({
    agent,
    appName: 'workflow-native',
    ...(resumable ? { resumabilityConfig: { isResumable: true } } : {}),
  });
  const session = await runner.sessionService.createSession({
    appName: 'workflow-native',
    userId: 'u',
    state: { 'temp:saved': 'temporary-a' },
  });
  type Message = NonNullable<Parameters<typeof runner.runAsync>[0]['newMessage']>;
  const segment = async (newMessage: Message): Promise<Event | undefined> => {
    let long: Event | undefined;
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage,
      runConfig: { streamingMode: StreamingMode.SSE, pauseOnToolCalls: false },
    })) {
      seen.events.push(event);
      const waiting =
        long !== undefined ||
        (event.content?.parts ?? []).some(
          (part) => part.functionCall?.name === 'adk_request_confirmation',
        );
      if (waiting && !uninterrupted) {
        seen.pauses += 1;
        stopped = true;
        return long ?? event;
      }
      if (
        (event.longRunningToolIds?.length ?? 0) > 0 &&
        event.content?.parts?.some((part) => part.functionCall !== undefined)
      )
        long = event;
    }
    return undefined;
  };
  let pending = await segment({ role: 'user', parts: [{ text: 'go' }] });
  for (let i = 0; pending !== undefined && i < 3; i++) {
    await delay(40); // Drain pending sibling work after the consumer stopped.
    stopped = false;
    const call = pending.content?.parts?.find(
      (part) =>
        part.functionCall?.name === 'adk_request_confirmation' ||
        pending?.longRunningToolIds?.includes(part.functionCall?.id ?? ''),
    )?.functionCall;
    if (call?.id === undefined || call.name === undefined)
      throw new Error('Missing native pause call.');
    try {
      pending = await segment({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: call.id,
              name: call.name,
              response: shape.long ? { saved: pending.author } : { confirmed: !shape.deny },
            },
          },
        ],
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

const expected: Record<string, { full: string; off: string; on: string; tools: string }> = {
  W1: { full: 'first first second', off: 'first first second', on: 'first first', tools: 'first' },
  W2: { full: 'a b b c', off: 'a b a b c', on: 'a b b', tools: 'b' },
  'W3-first': {
    full: 'inner inner b c',
    off: 'inner inner b c',
    on: 'inner inner',
    tools: 'inner',
  },
  'W3-later': { full: 'a b b c', off: 'a b a b c', on: 'a b b', tools: 'b' },
  W4: { full: 'a b b', off: 'a b a b', on: 'a b b', tools: 'b' },
  'W4-deny': { full: 'a b b', off: 'a b a b', on: 'a b b', tools: '' },
  'W4-nested': { full: 'a b c c', off: 'a b c a b c', on: 'a b c c', tools: 'c' },
  'W4-twice': { full: 'a b b b', off: 'a b a b a b', on: 'a b b b', tools: 'b b' },
  'W4-temp': { full: 'a b b', off: 'a b a b', on: 'a b b', tools: 'b' },
  'W5-worker': {
    full: 'worker worker worker',
    off: 'worker worker worker',
    on: 'worker worker',
    tools: 'worker',
  },
  'W5-writer': {
    full: 'writer writer checker checker writer writer checker',
    off: 'writer writer checker writer writer checker writer writer checker',
    on: 'writer writer checker checker',
    tools: 'writer checker',
  },
  'W6-left': {
    full: 'left right left right merger',
    off: 'left right right left merger',
    on: 'left right left',
    tools: 'right left',
  },
  'W6-right': {
    full: 'left right right left merger',
    off: 'left right right right left merger',
    on: 'left right right left',
    tools: 'right left',
  },
  'W6-last': {
    full: 'a left right left right',
    off: 'a left right a right left',
    on: 'a left right left',
    tools: 'right left',
  },
  'W6-both': {
    full: 'left right left right',
    off: 'left right right left',
    on: 'left right left',
    tools: 'left',
  },
  'W7-last': { full: 'a b b', off: 'a b', on: 'a b b', tools: 'b' },
  'W7-middle': { full: 'a b b c', off: 'a b', on: 'a b b', tools: 'b' },
  W8: {
    full: 'parent child child',
    off: 'parent child child',
    on: 'parent child child',
    tools: 'child',
  },
  'W8-workflow': {
    full: 'a parent child child c',
    off: 'a parent child a parent child c',
    on: 'a parent child child',
    tools: 'child',
  },
};

test.each(shapes)('$id measures every native gate with resumability off and on', async (shape) => {
  const full = await measure(shape, false, true);
  const off = await measure(shape, false);
  const on = await measure(shape, true);
  const row = expected[shape.id];
  if (row === undefined) throw new Error('Missing native gate row.');
  expect(full.requests.join(' ')).toBe(row.full);
  expect(off.requests.join(' ')).toBe(row.off);
  expect(on.requests.join(' ')).toBe(row.on);
  expect(on.tools.join(' ')).toBe(row.tools);
  expect(on.pauses).toBe(shape.twice ? 2 : 1);
  expect(on.error).toBeUndefined();
  expect(off.error).toBe(
    shape.long ? 'No function call event found for function responses ids: <call>' : undefined,
  );
  for (const lane of [full, off, on])
    expect(
      lane.events.every(
        (event) =>
          event.actions?.agentState === undefined &&
          event.actions?.endOfAgent === undefined &&
          event.nodeInfo === undefined,
      ),
    ).toBe(true);
  const after = on.states.at(-1);
  if (on.requests.includes('a') && !shape.temporary) expect(after?.persistent).toBe(true);
  if (shape.temporary) {
    // BaseSessionService trims temporary deltas before the event reaches the consumer.
    expect(
      on.events.every((event) => event.actions?.stateDelta?.['temp:saved'] === undefined),
    ).toBe(true);
    expect(on.states.filter((state) => state.tag === 'b').map((state) => state.temporary)).toEqual([
      false,
      false,
    ]);
  }
  if (shape.id.startsWith('W6')) {
    expect(on.branches.at(-1)).toBeUndefined();
    expect(on.events.some((event) => event.author === 'left' && event.branch !== undefined)).toBe(
      true,
    );
  }
  expect(on.late).toEqual(['W6-left', 'W6-last'].includes(shape.id) ? ['tool:right'] : []);
});
