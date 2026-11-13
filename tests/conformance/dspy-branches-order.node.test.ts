// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import type { PyodideAdapterOptions } from '../../packages/adapter-pyodide/src/adapter.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { executeDspyCase } from './support/dspy.js';
import { branchSources } from './support/dspy-branches-sources.node.js';
import { executeDspyParallelStep } from './support/dspy-parallel-step.js';
import { dspySources } from './support/dspy-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const conversation = '55de87eb-28d7-466f-9222-de0713ae5d68';
const labels = ['alpha', 'beta', 'gamma'];
const fixedIdentity = `\nimport uuid\nuuid.uuid4 = lambda: uuid.UUID('${conversation}')\n`;

/** Hold each round's responses until all three branches can finish in the selected order. */
function orderedResponses(
  options: PyodideAdapterOptions,
  order: readonly string[],
): {
  options: PyodideAdapterOptions;
  scopes: Record<string, string>;
  delivered: Map<string, string[]>;
} {
  const scopes: Record<string, string> = {};
  const delivered = new Map<string, string[]>();
  return {
    scopes,
    delivered,
    options: {
      ...options,
      createWorker() {
        const worker = options.createWorker();
        const requests = new Map<string, { group: string; label: string }>();
        const rounds = new Map<string, Map<string, string>>();
        worker.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          if (message.kind !== 'request' || !['model', 'capability'].includes(message.op)) return;
          const query =
            message.op === 'model'
              ? message.payload.messages
                  .findLast((item: { role: string }) => item.role === 'user')
                  ?.content.split('[[ ## question ## ]]\n')[1]
                  ?.split('\n\n')[0]
                  ?.trim()
              : message.payload.input.query;
          if (typeof query !== 'string') throw new Error('The branch query is missing.');
          const [label, phase = ''] = query.split(':');
          if (!label) throw new Error('The branch label is missing.');
          requests.set(message.id, { group: `${message.op}/${phase}`, label });
          if (message.op === 'capability') scopes[label] = message.payload.effectScope;
        });
        return {
          addEventListener: worker.addEventListener.bind(worker),
          removeEventListener: worker.removeEventListener.bind(worker),
          terminate: worker.terminate.bind(worker),
          postMessage(raw) {
            const message = JSON.parse(raw);
            const request = message.kind === 'response' ? requests.get(message.id) : undefined;
            if (!request) return worker.postMessage(raw);
            const round = rounds.get(request.group) ?? new Map<string, string>();
            rounds.set(request.group, round);
            round.set(request.label, raw);
            if (round.size !== labels.length) return;
            const completed: string[] = [];
            delivered.set(request.group, completed);
            for (const label of order) {
              const response = round.get(label);
              if (!response) throw new Error('The gated branch response is missing.');
              completed.push(label);
              worker.postMessage(response);
            }
          },
        };
      },
    },
  };
}

for (const shape of ['single', 'write', 'multi'] as const) {
  for (const order of ['forward', 'reversed'] as const) {
    test(`unordered fanout-${shape} pins absolute scopes with ${order} responses`, async () => {
      const name = `fanout-${shape}`;
      const sources = await dspySources(name);
      sources['selected.py'] += fixedIdentity;
      const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
      const arrival = order === 'forward' ? labels : [...labels].reverse();
      const observed = orderedResponses(fixture.options, arrival);
      try {
        const result = await executeDspyCase(observed.options, fixture.agent, name);
        expect(result.error).toBeNull();
        expect(Object.keys((result.output as { answers: object }).answers)).toEqual(labels);
        expect(observed.delivered.size).toBe(shape === 'multi' ? 3 : 1);
        for (const delivered of observed.delivered.values()) expect(delivered).toEqual(arrival);
        expect(observed.scopes).toEqual(
          shape === 'single'
            ? {}
            : Object.fromEntries(
                labels.map((key) => [
                  key,
                  `dspy/${conversation}/1/0/${key}/${shape === 'write' ? 0 : 1}`,
                ]),
              ),
        );
        expect(fixture.workerErrors).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    }, 900000);
  }
}

test.each(['forward', 'reversed'] as const)(
  'paused multi-call journal pins input keys then local ordinals: %s',
  async (order) => {
    const name = 'par-fan-two-stage-multi';
    const sources = await branchSources(name);
    sources['selected.py'] += fixedIdentity;
    const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const result = await executeDspyParallelStep(fixture.options, fixture.agent, store, {
        name,
        order,
      });
      expect(result.error).toBeUndefined();
      expect(result.pending).toBeDefined();
      const row = [...store.checkpoints.rows.values()].at(-1);
      const checkpoint = JSON.parse(new TextDecoder().decode(row?.checkpoint.bytes));
      expect(
        checkpoint.journal.slice(0, -1).map((entry: { fanout: string }) => entry.fanout),
      ).toEqual(labels.flatMap((key) => [0, 1, 2].map((call) => `0/before.${key}/${call}`)));
      expect(checkpoint.journal.at(-1).kind).toBe('interaction');
      expect(result.postTerminationRequests).toBe(0);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);
