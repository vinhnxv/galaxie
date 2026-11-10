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

import { createRuntime, defineAgentDefinition } from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { delegationModel } from './support/pydantic-ai-delegation.js';
import { delegationSources } from './support/pydantic-ai-delegation-sources.node.js';

test.skipIf(!pythonWheelsAvailable)(
  `delegation scaffold smoke (${missingPythonWheels} if skipped)`,
  async () => {
    const fixture = await createPythonFixture({
      sources: await delegationSources(),
      module: 'selected',
    });
    const { model, transcript } = delegationModel();
    const runtime = createRuntime({
      appId: 'delegation-probes',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'pydantic-ai' })],
    });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'conformance/delegation',
          version: '1',
          executor: 'pydantic-ai-python',
          input: z.unknown(),
          models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        }),
        {
          principalScope: 'fixture',
          agent: fixture.agent,
          services: { chatModels: { mock: model } },
          models: {
            providers: {
              mock: {
                destination: 'in-browser',
                modality: 'text',
                languages: ['en'],
                features: ['tool-calling', 'streaming'],
                pricing: { inputPerToken: 0, outputPerToken: 0 },
              },
            },
            roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
          },
        },
      );
      await instance.prepare();
      const run = await instance.start({ prompt: 'smoke' });
      const events = [];
      for await (const event of instance.events(run.runId)) events.push(event);
      expect(
        events.filter((event) => event.type === 'output').map((event) => event.output),
      ).toEqual(['done']);
      expect(transcript.requests).toHaveLength(1);
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  90000,
);
