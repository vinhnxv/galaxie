// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelRouting } from '@galaxie/core';
import { MockChatModel, type MockLatch } from '@galaxie/models/mock';
import { hostModels } from '../../host/runtime.js';

export const AUDITOR_SAMPLE_PROMPT =
  'Question: What did the invented Lantern Orchard Workshop display?\nAnswer: Lantern Orchard Workshop displayed a spacecraft.';
export const AUDITOR_EMPTY_PROMPT =
  'Question: What does Unknown Demo Company make?\nAnswer: Unknown Demo Company makes kites.';
export const AUDITOR_REVISED_ANSWER =
  'Lantern Orchard Workshop displayed a fictional cutting machine.';
export const AUDITOR_UNCHANGED_ANSWER = 'Unknown Demo Company makes kites.';

export function createAuditorMockModels(
  scenario: 'normal' | 'empty' | 'denied' = 'normal',
  wait?: MockLatch,
): {
  readonly chatModels: Readonly<Record<string, MockChatModel>>;
  readonly routing: ModelRouting;
} {
  const prompt = scenario === 'empty' ? AUDITOR_EMPTY_PROMPT : AUDITOR_SAMPLE_PROMPT;
  const findings =
    scenario === 'normal'
      ? 'Inaccurate: spacecraft. bulletin-lantern says Lantern Orchard Workshop displayed a fictional cutting machine. Overall: inaccurate in the fictional context.'
      : 'Unsupported: fixture evidence is unavailable; the claim is unverifiable. Leave the answer unchanged.';
  const descriptor = hostModels('mock').providers['mock'];
  if (!descriptor) throw new Error('The mock descriptor is missing.');
  return {
    chatModels: {
      critic: new MockChatModel(
        {
          [prompt]: [
            {
              id: 'search',
              text: '',
              ...(wait ? { wait } : {}),
              toolCalls: [
                {
                  id: 'search_0',
                  name: 'search_fixture',
                  args: {
                    query:
                      scenario === 'empty' ? 'Unknown Demo Company' : 'Lantern Orchard Workshop',
                  },
                },
              ],
            },
            { id: 'findings', text: findings },
          ],
        },
        { sequence: 'assistant-turns' },
      ),
      reviser: new MockChatModel(
        {
          [prompt]: {
            id: 'revision',
            text:
              scenario === 'normal'
                ? AUDITOR_REVISED_ANSWER
                : scenario === 'empty'
                  ? AUDITOR_UNCHANGED_ANSWER
                  : 'Lantern Orchard Workshop displayed a spacecraft.',
          },
        },
        { sequence: 'assistant-turns' },
      ),
    },
    routing: {
      providers: { critic: descriptor, reviser: descriptor },
      roles: {
        'auditor.critic': { providers: ['critic'], allow: ['in-browser'], maxTokens: 1500 },
        'auditor.reviser': { providers: ['reviser'], allow: ['in-browser'], maxTokens: 1500 },
      },
    },
  };
}
