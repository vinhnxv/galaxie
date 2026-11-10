// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  createPythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';
import {
  delegationCases,
  executeDelegationCase,
} from './support/pydantic-ai-delegation-conformance.js';
import { delegationSuiteSources } from './support/pydantic-ai-delegation-suite-sources.node.js';

test.skipIf(!pythonWheelsAvailable).each(delegationCases)(
  'Node Pyodide matches native delegation: %s',
  async (name) => {
    const fixture = await createPythonFixture({
      sources: await delegationSuiteSources(name),
      module: 'selected',
    });
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    try {
      const transcript = await executeDelegationCase(fixture.options, fixture.agent, store, name);
      const golden = JSON.parse(
        await readFile(
          new URL(`./golden-pydantic-ai-delegation/${name}.json`, import.meta.url),
          'utf8',
        ),
      );
      expect(transcript).toEqual(golden);
      const lifetimes = name === 'delegation-reload-write' ? 2 : 1;
      expect(fixture.counts.created).toBe(lifetimes);
      expect(fixture.counts.terminated).toBe(lifetimes);
      expect(fixture.workerErrors).toEqual([]);
      expect(store.recovery.journal.size).toBe(name === 'delegation-reload-write' ? 1 : 0);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);
