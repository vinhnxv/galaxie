// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { lessonFixture } from '../src/index.js';
import { draft, sentence, tutorFixture } from './support.js';

test('the tutor commits one quiz, grades it, reviews writing and saves after Feedback', async () => {
  const tutor = await tutorFixture();
  try {
    let pending = tutor.instance.getSnapshot().run?.pending;
    expect(pending?.component).toBe('education.Quiz/v1');
    expect(pending?.props).toEqual({
      title: lessonFixture.title,
      questions: draft.questions.map((question, index) => ({
        id: `q${index + 1}`,
        prompt: question.prompt,
        options: question.options.map((option, optionIndex) => ({
          id: String.fromCharCode(97 + optionIndex),
          label: option.label,
        })),
      })),
    });
    expect(JSON.stringify(pending?.props)).not.toContain('correctOptionId');
    expect(JSON.stringify(pending?.props)).not.toContain('answerKey');
    expect(tutor.saves).toEqual([]);
    await tutor.advance({ answers: { q1: 'b', q2: 'b', q3: 'c' } });
    expect(tutor.instance.getSnapshot().run?.pending?.component).toBe('education.WritingPrompt/v1');
    expect(tutor.quizModel.calls).toBe(1);
    await tutor.advance({ sentence });
    pending = tutor.instance.getSnapshot().run?.pending;
    expect(pending?.component).toBe('education.Feedback/v1');
    expect(pending?.props).toMatchObject({
      items: [
        { id: 'q1', kind: 'correct', text: `${draft.questions[0]?.prompt} Correct answer: walks.` },
        {
          id: 'q2',
          kind: 'incorrect',
          text: `${draft.questions[1]?.prompt} Correct answer: play.`,
        },
        {
          id: 'q3',
          kind: 'correct',
          text: `${draft.questions[2]?.prompt} Correct answer: drinks.`,
        },
        { id: 'review1', kind: 'info', text: 'Your subject and verb agree.' },
      ],
    });
    expect(tutor.instance.getSnapshot().run?.labels).toContain('private-user');
    expect(tutor.saves).toEqual([]);
    await tutor.advance({}, 'continue');
    expect(tutor.instance.getSnapshot().run?.pending).toMatchObject({
      component: 'education.Progress/v1',
      props: { label: lessonFixture.title, current: 2, total: 3 },
    });
    expect(tutor.saves).toEqual([{ lessonId: lessonFixture.id, score: 2, total: 3 }]);
    await tutor.advance({}, 'continue');
    expect(tutor.instance.getSnapshot().run?.status).toBe('succeeded');
    const output = tutor.events.find((event) => event.type === 'output');
    expect(output).toMatchObject({
      type: 'output',
      output: { lessonId: lessonFixture.id, score: 2, total: 3, saved: true },
    });
    if (output?.type !== 'output') throw new Error('The tutor output is missing.');
    expect(output.output).toEqual({ lessonId: lessonFixture.id, score: 2, total: 3, saved: true });
    expect(tutor.quizModel.calls).toBe(1);
    expect(tutor.reviewModel.calls).toBe(1);
    expect(tutor.saves).toHaveLength(1);
    // Native streams remain diagnostic graph data even though the run output is projected.
    expect(JSON.stringify(tutor.events.filter((event) => event.type === 'stream'))).toContain(
      'answerKey',
    );
    expect(JSON.stringify(tutor.events.filter((event) => event.type !== 'stream'))).not.toContain(
      sentence,
    );
    expect(JSON.stringify(tutor.diagnostics)).not.toContain(sentence);
    expect(tutor.spans()).not.toContain(sentence);
  } finally {
    await tutor.dispose();
  }
});

test('missing and unknown answers count as wrong against the committed key', async () => {
  const tutor = await tutorFixture();
  try {
    await tutor.advance({ answers: { q1: 'b', q2: 'unknown' } });
    await tutor.advance({ sentence });
    expect(tutor.instance.getSnapshot().run?.pending?.props).toMatchObject({
      items: [
        { id: 'q1', kind: 'correct' },
        { id: 'q2', kind: 'incorrect' },
        { id: 'q3', kind: 'incorrect' },
        { kind: 'info' },
      ],
    });
    await tutor.advance({}, 'continue');
    expect(tutor.saves).toEqual([{ lessonId: lessonFixture.id, score: 1, total: 3 }]);
  } finally {
    await tutor.dispose();
  }
});

test('a draft with a correct option outside its options fails with a fixed invalid error', async () => {
  const invalid = structuredClone(draft);
  const first = invalid.questions[0];
  if (first === undefined) throw new Error('The quiz fixture is empty.');
  first.correctOptionId = 'absent';
  const tutor = await tutorFixture({ draft: invalid });
  try {
    expect(tutor.instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'invalid' },
    });
    expect(tutor.saves).toEqual([]);
    expect(tutor.reviewModel.calls).toBe(0);
    expect(JSON.stringify(tutor.events.filter((event) => event.type !== 'stream'))).not.toContain(
      first.prompt,
    );
  } finally {
    await tutor.dispose();
  }
});

test('private writing never dispatches a host-server feedback call', async () => {
  const tutor = await tutorFixture({ remoteReview: true });
  try {
    await tutor.advance({ answers: { q1: 'b' } });
    await tutor.advance({ sentence });
    expect(tutor.instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      labels: expect.arrayContaining(['private-user']),
      error: { code: 'denied' },
    });
    expect(tutor.reviewModel.calls).toBe(0);
    expect(tutor.saves).toEqual([]);
    expect(JSON.stringify(tutor.instance.getSnapshot())).not.toContain(sentence);
    expect(JSON.stringify(tutor.diagnostics)).not.toContain(sentence);
    expect(tutor.spans()).not.toContain(sentence);
  } finally {
    await tutor.dispose();
  }
});

test('provider errors with learner text are fixed outside the host-only diagnostic error field', async () => {
  const tutor = await tutorFixture({ reviewError: new Error(sentence) });
  try {
    await tutor.advance({ answers: { q1: 'b' } });
    await tutor.advance({ sentence });
    expect(tutor.instance.getSnapshot().run?.status).toBe('failed');
    expect(JSON.stringify(tutor.instance.getSnapshot())).not.toContain(sentence);
    expect(JSON.stringify(tutor.events.filter((event) => event.type !== 'stream'))).not.toContain(
      sentence,
    );
    expect(
      JSON.stringify(tutor.diagnostics.map(({ error: _error, ...fields }) => fields)),
    ).not.toContain(sentence);
    expect(tutor.spans()).not.toContain(sentence);
  } finally {
    await tutor.dispose();
  }
});
