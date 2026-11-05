// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createMockLatch } from '@galaxie/models/mock';
import { expect, test } from 'vitest';
import {
  AUDITOR_REVISED_ANSWER,
  AUDITOR_UNCHANGED_ANSWER,
} from '../src/recipes/llm-auditor/script.js';
import { runAuditor } from './support/python.js';
import { pythonWheelsAvailable, recipeFixture } from './support/python.node.js';

test.skipIf(!pythonWheelsAvailable).each(['normal', 'empty', 'denied'] as const)(
  'the Python auditor critic and reviser finish with fixture evidence: %s',
  async (scenario) => {
    const fixture = await recipeFixture('llm_auditor');
    try {
      const result = await runAuditor(fixture.options, fixture.agent, scenario);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('succeeded');
      expect(result.output).toBe(
        scenario === 'normal'
          ? AUDITOR_REVISED_ANSWER
          : scenario === 'empty'
            ? AUDITOR_UNCHANGED_ANSWER
            : 'Lantern Orchard Workshop displayed a spacecraft.',
      );
      expect(result.searches).toHaveLength(1);
      const requests = fixture.fromWorker
        .map((raw) => JSON.parse(raw))
        .filter((frame) => frame.op === 'model');
      expect(requests.map((frame) => frame.payload.role)).toEqual([
        'auditor.critic',
        'auditor.critic',
        'auditor.reviser',
      ]);
      const reviser = JSON.stringify(requests.at(-1));
      expect(reviser).toContain(scenario === 'normal' ? 'bulletin-lantern' : 'unverifiable');
      if (scenario === 'denied') {
        expect(JSON.stringify(requests)).toContain('Policy denied the request.');
        expect(JSON.stringify(requests)).not.toContain('Host detail');
      }
      expect(result.output).not.toContain('---END-OF-EDIT---');
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

test.skipIf(!pythonWheelsAvailable)(
  'aborting the critic settles as cancelled',
  async () => {
    const fixture = await recipeFixture('llm_auditor');
    const wait = createMockLatch();
    try {
      const result = await runAuditor(fixture.options, fixture.agent, 'normal', wait);
      expect(result.status).toBe('cancelled');
      expect(result.output).toBeUndefined();
      expect(result.searches).toEqual([]);
    } finally {
      wait.release();
      await fixture.cleanup();
    }
  },
  90000,
);
