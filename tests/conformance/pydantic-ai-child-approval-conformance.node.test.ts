// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createPythonFixture,
  type PythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';
import {
  childApprovalCases,
  executeChildApprovalCase,
} from './support/pydantic-ai-child-approval-conformance.js';
import { childApprovalSuiteSources } from './support/pydantic-ai-child-approval-suite-sources.node.js';

describe.skipIf(!pythonWheelsAvailable)('Node Pyodide child approval conformance', () => {
  let fixture: PythonFixture;
  beforeAll(async () => {
    fixture = await createPythonFixture({
      sources: await childApprovalSuiteSources(childApprovalCases),
      module: 'selected',
      entry: 'child_approval_approve',
    });
  }, 900000);
  afterAll(async () => {
    await fixture?.cleanup();
  }, 900000);

  test.each(childApprovalCases)(
    'matches native: %s',
    async (name) => {
      const created = fixture.counts.created;
      const terminated = fixture.counts.terminated;
      const requestOffset = fixture.fromWorker.length;
      const store = {
        checkpoints: new MemoryByteCheckpoints(),
        recovery: new MemoryRecoveryStore(),
      };
      const result = await executeChildApprovalCase(
        fixture.options,
        { ...fixture.agent, entry: name.replaceAll('-', '_') },
        store,
        name,
      );
      const golden = JSON.parse(
        await readFile(
          new URL(`./golden-pydantic-ai-child-approval/${name}.json`, import.meta.url),
          'utf8',
        ),
      );
      expect(result.transcript).toEqual(golden);
      const requests = fixture.fromWorker
        .slice(requestOffset)
        .map(
          (raw) =>
            JSON.parse(raw) as {
              kind: string;
              op: string;
              payload: { role?: string; effectScope?: string };
            },
        )
        .filter((message) => message.kind === 'request');
      const approve = name !== 'child-approval-reject';
      const writes = requests.filter((message) => message.op === 'capability');
      expect(writes).toHaveLength(approve ? 1 : 0);
      if (approve)
        expect(writes[0]?.payload.effectScope).toMatch(/^pydantic-ai\/[0-9a-f]{64}\/\d+\/\d+$/);
      expect(
        requests.filter((message) => message.op === 'model').map((message) => message.payload.role),
      ).toEqual(approve ? ['parent', 'child', 'child', 'parent'] : ['parent', 'child', 'parent']);
      expect(store.recovery.journal.size).toBe(approve ? 1 : 0);
      const lifetimes = name === 'child-approval-restore' ? 2 : 1;
      expect(fixture.counts.created - created).toBe(lifetimes);
      expect(fixture.counts.terminated - terminated).toBe(lifetimes);
      expect(fixture.workerErrors).toEqual([]);
      expect(result.subgraphs).toBe(false);
      if (name === 'child-approval-restore') {
        expect(result.lifetimes[0]?.pending).toBeDefined();
        expect(result.lifetimes[1]?.restored).toEqual(result.lifetimes[0]?.pending);
        expect(result.lifetimes.map((lifetime) => lifetime.writes)).toEqual([0, 1]);
        expect(result.lifetimes[1]?.pending).toBeUndefined();
      }
    },
    900000,
  );
});
