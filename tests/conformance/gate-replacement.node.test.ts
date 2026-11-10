// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { BREAKPOINT_SHAPES, breakpointGraph, compiledSettings } from './cases/breakpoint-shapes.js';
import { GATE_CASE_NAMES, gateCases } from './cases/gates.js';
import { normalize } from './support/normalize.js';
import { runNative } from './support/transcript.js';

test('native compiled breakpoint shapes record why they are refused', async () => {
  const langgraph = await import('@langchain/langgraph');
  const evidence: Record<string, unknown> = {};
  for (const shape of BREAKPOINT_SHAPES) {
    const { graph, settings, counts } = breakpointGraph(
      langgraph,
      new langgraph.MemorySaver(),
      shape,
    );
    const config = { configurable: { thread_id: crypto.randomUUID() } };
    const updates = [];
    for await (const chunk of await graph.stream(
      { value: 1 },
      { ...config, streamMode: ['updates'], subgraphs: true },
    ))
      updates.push(chunk);
    const state = await graph.getState(config);
    const interruptCount = state.tasks.flatMap(({ interrupts }) => interrupts).length;
    expect(state.next.length).toBeGreaterThan(0);
    expect(interruptCount).toBe(0);
    evidence[shape] = {
      compiled: compiledSettings(graph),
      ...(shape === 'child' ? { child: settings } : {}),
      next: state.next,
      interruptCount,
      tail: updates.at(-1),
      rootInterrupt: updates.some((chunk) => {
        const [path, , data] = chunk as [string[], string, object];
        return path.length === 0 && '__interrupt__' in data;
      }),
      counts,
      refusal: {
        phase: 'prepare',
        code: 'unsupported',
        message: 'The graph must not use compiled static breakpoints.',
      },
    };
  }
  await expect(`${JSON.stringify(normalize(evidence), null, 2)}\n`).toMatchFileSnapshot(
    './golden/compiled-breakpoints.json',
  );
});

test.each(GATE_CASE_NAMES)('native %s matches its golden', async (name) => {
  const langgraph = await import('@langchain/langgraph');
  const transcript = await runNative(gateCases[name], langgraph);
  expect(transcript.outcome).toEqual({ status: 'succeeded' });
  expect(transcript.pauses).toHaveLength(1);
  expect(transcript.state.next).toEqual([]);
  expect(transcript.final).toEqual(
    name === 'gate-continue'
      ? { value: 2, decision: 'continue', counts: { prepare: 1, work: 1 } }
      : { value: 1, decision: 'reject' },
  );
  await expect(`${JSON.stringify(normalize(transcript), null, 2)}\n`).toMatchFileSnapshot(
    `./golden/${name}.json`,
  );
});
