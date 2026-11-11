// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/* Fixed before observations: green tests pin behavior, satisfaction decides outcomes.
 * Unmeasured P0 => undetermined. P1 is informational. Gap 1 P0: D1-D5/G1/G2;
 * supported only if all satisfy plain/usage unchanged; alternative only if a helper
 * or flattened form satisfies all (one Python function, no core export/bridge
 * change), D3 holds and plain/usage D2/D4/D5 fails. Otherwise refused if D3 fails
 * or no variant satisfies D1-D5. Failed public G1 caps helper at alternative by
 * documentation, otherwise refused with no guard available.
 * Gap 2 P0 P1-P4: supported if P1/P2 execute no unapproved bodies and hoist P3/P4
 * completes/restores in both lanes; alternative if CPython P3 holds, Node P3/P4
 * fails and flattened F1 passes both lanes. Otherwise refused; any P1/P2
 * unapproved body => unsafe as shipped, reported first.
 * Gap 3 P0 S1: supported only for stable child paths AND supported Gap 2;
 * otherwise refused; no alternative.
 * Satisfaction: D1 exact host totals; D2 <= parent request limit; D3 forbidden
 * provider sees no private call; D4 stable disjoint scopes; D5 one write/same
 * restored effect; D6 repair zero per child; D7 checked/projected child deltas;
 * D8 non-bridge child visible; P1/P2 zero unapproved bodies; P3 approved child
 * completes once; P4 same pending and exactly-once writes after reload; P5 records
 * parallel pending; P6 rejects extra fields/tampered metadata; S1 stable child
 * stream paths; S2 subgraphs false; G1 public nested detection without false
 * positives; G2 unsupported before nested bridge request; F1 flat gate restores
 * and writes once. Full lane/priority table is in delegation.py's docstring.
 */

import { expect, test } from 'vitest';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import {
  type DelegationStep,
  delegationStore,
  executeDelegationProbe,
} from './support/pydantic-ai-delegation.js';
import { delegationSources } from './support/pydantic-ai-delegation-sources.node.js';

const probe = test.skipIf(!pythonWheelsAvailable);
async function measure(step: DelegationStep, variant = 'helper') {
  const fixture = await createPythonFixture({
    sources: await delegationSources(step.name, variant),
    module: 'selected',
  });
  try {
    const result = await executeDelegationProbe(fixture.options, fixture.agent, step);
    const bridge = fixture.fromWorker
      .map(
        (raw) =>
          JSON.parse(raw) as {
            kind: string;
            op: string;
            payload: {
              role?: string;
              effectScope?: string;
              options?: { repairAttempt?: number; stream?: boolean };
            };
          },
      )
      .filter((message) => message.kind === 'request');
    const modelReplies = fixture.toWorker
      .map(
        (raw) =>
          JSON.parse(raw) as {
            kind: string;
            op: string;
            ok?: boolean;
            payload: {
              usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
            };
          },
      )
      .filter((message) => message.kind === 'response' && message.op === 'model' && message.ok);
    return { ...result, bridge, modelReplies };
  } finally {
    await fixture.cleanup();
  }
}

probe(
  `delegation scaffold smoke (${missingPythonWheels} if skipped)`,
  async () => {
    const result = await measure({ name: 'smoke' });
    expect(result.transcript.output).toBe('done');
    expect(result.transcript.error).toBeNull();
    expect(result.transcript.requests).toHaveLength(1);
  },
  90000,
);

// P0 accounting clause: core sees each bridged model/capability exactly once.
probe.each(['helper'])(
  'D1 exact shared accounting: %s',
  async (variant) => {
    const result = await measure(
      { name: 'delegation', budgets: { tokens: 16, cost: 16, toolCalls: 2 } },
      variant,
    );
    expect(result.transcript.error).toBeNull();
    expect(result.transcript.output).toBe('parent-done');
    expect(result.transcript.requests).toHaveLength(4);
    expect(result.transcript.capabilities).toHaveLength(2);
    // Core exposes no aggregate usage snapshot for this executor. The exact-budget
    // run and the one-unit-below refusals below prove settlement across both runs.
    expect(result.modelReplies.map((reply) => reply.payload.usage)).toEqual(
      Array.from({ length: 4 }, () => ({ input_tokens: 2, output_tokens: 2, total_tokens: 4 })),
    );
    expect(result.subgraphs).toBe(false);
    expect(
      result.bridge
        .filter((message) => message.op === 'model')
        .map((message) => message.payload.role),
    ).toEqual(['answer', 'child', 'child', 'answer']);
  },
  90000,
);

probe.each(['tokens', 'cost', 'toolCalls'] as const)(
  'D1 %s budget refuses the first call beyond the exact allowance',
  async (budget) => {
    const result = await measure({
      name: 'delegation',
      budgets: { [budget]: budget === 'toolCalls' ? 1 : 15 },
    });
    expect(result.transcript.error).toMatchObject({ code: 'budget_exceeded' });
    expect(result.transcript.requests).toHaveLength(budget === 'toolCalls' ? 2 : 3);
    expect(result.transcript.capabilities).toHaveLength(budget === 'toolCalls' ? 1 : 2);
    expect(
      result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes[
        'galaxie.budget.name'
      ],
    ).toBe(budget);
  },
  90000,
);

// The shipped guard refuses plain variants; the helper shares the step budget.
probe.each(['plain', 'usage', 'conv', 'helper'])(
  'D2 total requests at parent step limit 3: %s',
  async (variant) => {
    const result = await measure({ name: 'steps', budgets: { steps: 3 } }, variant);
    expect(result.transcript.requests).toHaveLength(variant === 'helper' ? 3 : 1);
    expect(result.transcript.error).toMatchObject({
      code: variant === 'helper' ? 'budget_exceeded' : 'unsupported',
    });
    expect(result.transcript.capabilities).toEqual([]);
  },
  90000,
);

// P0 labels clause: one allowed child call precedes the labeled read; no later one reaches remote.
probe(
  'D3 child private output denies the next remote call before provider dispatch',
  async () => {
    const result = await measure({ name: 'labels', privateOutput: true, remoteChild: true });
    expect(result.transcript.error).toMatchObject({ code: 'denied' });
    expect(result.snapshot.run?.labels).toContain('private-user');
    expect(result.transcript.requests).toHaveLength(2);
    expect(result.transcript.capabilities).toHaveLength(1);
    expect(
      result.bridge
        .filter((message) => message.op === 'model')
        .map((message) => message.payload.role),
    ).toEqual(['answer', 'child', 'child']);
    expect(result.snapshot.routes?.['child']).toEqual({
      providerId: 'remote',
      destination: 'third-party',
    });
  },
  90000,
);

probe.each(['helper', 'id-control'])(
  'D5 restore mid-delegate write after a regenerated delegate ID: %s',
  async (variant) => {
    const store = delegationStore();
    const first = await measure(
      { name: 'recovery', store, answer: true, crashAfterWrite: true },
      variant,
    );
    expect(first.crashed).toBe(true);
    expect(first.writes.map((write) => write.value)).toEqual([2]);
    expect(first.pending).toBeDefined();
    const firstEffects = store.effects.slice();
    expect(firstEffects).toEqual(first.writes.map((write) => write.effectId));
    const second = await measure(
      {
        name: 'recovery',
        store,
        sessionId: first.sessionId,
        answer: true,
        delegateId: 'regenerated-delegate',
      },
      variant,
    );
    expect(second.transcript.error).toBeNull();
    expect(second.transcript.output).toBe('parent-done');
    const before = first.bridge
      .filter((message) => message.op === 'capability')
      .map((message) => message.payload.effectScope);
    const after = second.bridge
      .filter((message) => message.op === 'capability')
      .map((message) => message.payload.effectScope);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0] === before[0]).toBe(variant === 'helper');
    const restoredEffects = store.effects.slice(firstEffects.length);
    expect(restoredEffects).toHaveLength(1);
    expect(restoredEffects[0] === firstEffects[0]).toBe(variant === 'helper');
    expect([...first.writes, ...second.writes].map((write) => write.value)).toEqual(
      variant === 'id-control' ? [2, 2] : [2],
    );
    const records = [...store.recovery.journal.values()];
    expect(records).toHaveLength(variant === 'id-control' ? 2 : 1);
    expect(records.every((record) => record.status === 'succeeded')).toBe(true);
  },
  90000,
);

// P0 pause clause: child data is not a host pause, but its gated body must stay unexecuted.
probe(
  'P2 returned child deferral is ordinary parent tool data',
  async () => {
    const result = await measure({ name: 'returned-pause' });
    expect(result.transcript.output).toBe('parent-done');
    expect(result.transcript.error).toBeNull();
    expect(result.transcript.interactions).toEqual([]);
    expect(result.transcript.capabilities).toEqual([]);
    expect(result.transcript.requests).toHaveLength(3);
  },
  90000,
);

probe(
  'P3 hoisted child approval resumes once in the same Worker',
  async () => {
    const result = await measure(
      { name: 'hoist', answer: true, store: delegationStore() },
      'helper',
    );
    expect(result.transcript.error).toBeNull();
    expect(result.transcript.output).toBe('parent-done');
    expect(result.transcript.interactions).toHaveLength(1);
    expect(result.writes.map((write) => write.value)).toEqual([2, 3]);
    expect(result.transcript.requests).toHaveLength(5);
  },
  90000,
);

probe(
  'P4 hoisted child state survives snapshot and fresh Worker',
  async () => {
    const store = delegationStore();
    const first = await measure({ name: 'hoist', store }, 'helper');
    expect(first.pending).toBeDefined();
    expect(first.writes.map((write) => write.value)).toEqual([2]);
    const second = await measure(
      { name: 'hoist', store, sessionId: first.sessionId, answer: true },
      'helper',
    );
    expect(second.restored).toEqual(first.pending);
    expect(second.transcript.error).toBeNull();
    expect(second.transcript.output).toBe('parent-done');
    expect([...first.writes, ...second.writes].map((write) => write.value)).toEqual([2, 3]);
    expect(store.recovery.journal.size).toBe(2);
  },
  90000,
);

probe(
  'F1 flattened gate restores and writes once',
  async () => {
    const store = delegationStore();
    const first = await measure({ name: 'flatten', store });
    expect(first.pending).toBeDefined();
    expect(first.writes).toEqual([]);
    const second = await measure({
      name: 'flatten',
      store,
      sessionId: first.sessionId,
      answer: true,
    });
    expect(second.restored).toEqual(first.pending);
    expect(second.transcript.error).toBeNull();
    expect(second.transcript.output).toBe('parent-done');
    expect(second.writes.map((write) => write.value)).toEqual([3]);
    expect(store.recovery.journal.size).toBe(1);
  },
  90000,
);

// Streaming children have no supported host path and are refused before dispatch.
probe(
  'D7/S1 plain child streaming is refused and subgraphs stays false',
  async () => {
    const result = await measure({ name: 'stream' });
    expect(result.transcript.error).toMatchObject({ code: 'unsupported' });
    expect(result.transcript.output).toBeNull();
    expect(result.transcript.requests).toHaveLength(1);
    expect(result.transcript.capabilities).toEqual([]);
    expect(result.checks).not.toContain('child-stream');
    expect(result.bridge.filter((message) => message.payload.role === 'child')).toEqual([]);
    expect(result.subgraphs).toBe(false);
  },
  90000,
);

probe(
  'D6 sequential native children each start at repair zero with no repair allowance',
  async () => {
    const result = await measure({
      name: 'native',
      repairAttempts: 0,
      budgets: { repairAttempts: 0 },
    });
    expect(result.transcript.error).toBeNull();
    expect(result.transcript.output).toBe('parent-done');
    expect(result.transcript.requests).toHaveLength(5);
    expect(
      result.bridge
        .filter((message) => message.op === 'model' && message.payload.role === 'child')
        .map((message) => message.payload.options?.repairAttempt ?? 0),
    ).toEqual([0, 0]);
  },
  90000,
);

// The shipped guard uses only public run identities at model and capability calls.
probe.each(['guard', 'guard-stream'])(
  'G2 %s refuses nested work before its first bridge request',
  async (name) => {
    const result = await measure({ name });
    expect(result.transcript.error).toMatchObject({ code: 'unsupported' });
    expect(result.transcript.requests).toHaveLength(1);
    expect(
      result.bridge
        .filter((message) => message.op === 'model')
        .map((message) => message.payload.role),
    ).toEqual(['answer']);
    expect(result.transcript.capabilities).toEqual([]);
  },
  90000,
);

probe(
  'G2 capability guard refuses an approved child before its next model request',
  async () => {
    const store = delegationStore();
    const first = await measure({ name: 'hoist', store }, 'helper');
    expect(first.pending).toBeDefined();
    expect(first.writes.map((write) => write.value)).toEqual([2]);
    const restored = await measure(
      { name: 'hoist', store, sessionId: first.sessionId, answer: true },
      'plain',
    );
    expect(restored.restored).toEqual(first.pending);
    expect(restored.transcript.error).toMatchObject({ code: 'unsupported' });
    expect(
      restored.bridge.filter((message) => message.op === 'model' || message.op === 'capability'),
    ).toEqual([]);
    expect(restored.writes).toEqual([]);
  },
  90000,
);
