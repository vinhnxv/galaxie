// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { lessonFixture } from '@galaxie/example-english-tutor';
import { createRegistry, educationComponents, WritingPrompt } from '@galaxie/react';
import { expect, test } from 'vitest';
import { sentence, tutorFixture } from '../../examples/english-tutor/test/support.js';

test('the complete tutor resolves through the real education registry in Chromium', async () => {
  const registry = createRegistry({ components: educationComponents });
  const tutor = await tutorFixture({ ui: registry.bindings({ surfaces: ['lesson-main'] }) });
  try {
    const resolve = (component: string): void => {
      const pending = tutor.instance.getSnapshot().run?.pending;
      expect(pending?.component).toBe(component);
      if (pending === undefined) throw new Error('The tutor interaction is missing.');
      expect(registry.resolve(pending)).toMatchObject({ ok: true });
    };
    resolve('education.Quiz/v1');
    await tutor.advance({ answers: { q1: 'b', q2: 'b', q3: 'c' } });
    resolve('education.WritingPrompt/v1');
    await tutor.advance({ sentence });
    resolve('education.Feedback/v1');
    expect(tutor.instance.getSnapshot().run?.labels).toContain('private-user');
    expect(tutor.saves).toEqual([]);
    await tutor.advance({}, 'continue');
    resolve('education.Progress/v1');
    expect(tutor.instance.getSnapshot().run?.pending?.props).toEqual({
      label: lessonFixture.title,
      current: 2,
      total: 3,
    });
    await tutor.advance({}, 'continue');
    expect(tutor.instance.getSnapshot().run?.status).toBe('succeeded');
    const output = tutor.events.find((event) => event.type === 'output');
    if (output?.type !== 'output') throw new Error('The tutor output is missing.');
    expect(output.output).toEqual({ lessonId: lessonFixture.id, score: 2, total: 3, saved: true });
    expect(tutor.quizModel.calls).toBe(1);
    expect(tutor.reviewModel.calls).toBe(1);
    expect(tutor.saves).toEqual([{ lessonId: lessonFixture.id, score: 2, total: 3 }]);
  } finally {
    await tutor.dispose();
  }
});

test('creation rejects a registry without WritingPrompt', async () => {
  const registry = createRegistry({
    components: educationComponents.filter((entry) => entry.id !== WritingPrompt.id),
  });
  await expect(
    tutorFixture({ ui: registry.bindings({ surfaces: ['lesson-main'] }) }),
  ).rejects.toMatchObject({ code: 'unsupported' });
});
