// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { lessonFixture } from '@galaxie/example-english-tutor';
import { MockChatModel } from '@galaxie/models/mock';

export const sentinelSentence = 'Galaxie remote sentinel 9a2d she walk to school';

/** Loaded only in test mode; no browser-managed model or download is used. */
export function mockFeedback(): MockChatModel {
  return new MockChatModel({
    [JSON.stringify({
      rubric: lessonFixture.rubric,
      grammarPoint: lessonFixture.grammarPoint,
      sentence: sentinelSentence,
    })]: {
      id: 'remote-host-feedback',
      text: JSON.stringify({
        verdict: 'needs_work',
        comments: ['Use walks with she: She walks to school.'],
      }),
    },
  });
}
