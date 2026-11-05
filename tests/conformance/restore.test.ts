// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { SessionId } from '@galaxie/core';
import { MemorySaver } from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { cases } from './cases/index.js';
import interruptDurabilityExit from './golden/interrupt-durability-exit.json' with { type: 'json' };
import interruptDurabilitySync from './golden/interrupt-durability-sync.json' with { type: 'json' };
import interruptResume from './golden/interrupt-resume.json' with { type: 'json' };
import interruptSubgraph from './golden/interrupt-subgraph.json' with { type: 'json' };
import { normalize } from './support/normalize.js';
import { runGalaxie } from './support/transcript.js';

const restoreCases = {
  'interrupt-resume': interruptResume,
  'interrupt-subgraph': interruptSubgraph,
  'interrupt-durability-sync': interruptDurabilitySync,
  'interrupt-durability-exit': interruptDurabilityExit,
} as const;

test.each(Object.keys(restoreCases) as (keyof typeof restoreCases)[])(
  '%s restores and dispatches the committed interrupt across runtimes',
  async (name) => {
    const saver = new MemorySaver();
    const paused = await runGalaxie(cases[name], () => saver, true);
    const first = await saver.list({}).next();
    const sessionId = first.value?.config.configurable?.['thread_id'] as SessionId;
    expect(typeof sessionId).toBe('string');
    const restored = await runGalaxie(cases[name], () => saver, false, sessionId);
    const golden = restoreCases[name];
    expect(restored.outcome).toEqual({ status: 'succeeded' });
    expect(restored.pauses).toEqual(paused.pauses);
    expect(normalize({ pauses: restored.pauses })).toEqual({ pauses: golden.pauses });
    expect(paused.state.next).toEqual(
      golden.checkpoints[(golden.pauses[0]?.historyLength ?? 0) - 1]?.next,
    );
    const { counts, ...values } = restored.final as Record<string, unknown>;
    expect(values).toEqual({ value: golden.final.value, answer: golden.final.answer });
    expect(restored.state.next).toEqual(golden.state.next);
    expect(counts).toEqual(
      name === 'interrupt-subgraph' ? { callSub: 1, s1: 0, sask: 1 } : { prepare: 0, ask: 1 },
    );
  },
);
