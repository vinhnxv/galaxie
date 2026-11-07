// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createMockLatch, MockDecisionModel, MockModelError } from '../src/mock.js';

const request = {
  state: 'sample',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Choose.',
      options: { ask: 'Ask', answer: 'Answer' },
    },
  },
};
const options = { signal: new AbortController().signal, maxTokens: 64 };

test('scripts deterministic boolean, choice, multiple choice and score with independent evidence', async () => {
  const replies = [
    { answers: { check: { value: true } } },
    {
      answers: {
        route: { value: 'ask', probabilities: { ask: 0.75, answer: 0.25 }, confidence: 0.9 },
      },
      usage: { inputTokens: 12, outputTokens: 0 },
    },
    {
      answers: {
        tags: {
          value: ['a', 'b'],
          probabilities: { a: { yes: 0.8, no: 0.2 }, b: { yes: 0.6, no: 0.4 } },
        },
      },
    },
    { answers: { score: { value: 1, probabilities: { '0': 0.1, '1': 0.9 } } } },
  ];
  const model = new MockDecisionModel(replies);
  for (const reply of replies) expect(await model.decide(request, options)).toEqual(reply);
  expect(model.calls).toBe(4);
  expect(model.recordedCalls).toEqual(Array.from({ length: 4 }, () => ({ request, ...options })));
  expect(
    Object.values(replies[1]?.answers.route?.probabilities ?? {}).reduce((sum, p) => sum + p, 0),
  ).toBe(1);
});

test('deliberately invalid replies and errors reach the validator without mock inference or repair', async () => {
  const invalid = { answers: { route: { value: 'outside-options' } } };
  const error = new MockModelError('Scripted failure.');
  const model = new MockDecisionModel([{ invalid }, { error }]);
  expect(await model.decide(request, options)).toBe(invalid);
  await expect(model.decide(request, options)).rejects.toBe(error);
  await expect(model.decide(request, options)).rejects.toThrowError(
    'The mock has no script for this decision call.',
  );
  expect(model.calls).toBe(3);
});

test('a latch releases exactly the waiting scripted call', async () => {
  const wait = createMockLatch();
  const reply = { answers: { route: { value: 'ask' } } };
  const model = new MockDecisionModel([{ ...reply, wait }]);
  const pending = model.decide(request, options);
  await wait.entered;
  expect(model.calls).toBe(1);
  wait.release();
  expect(await pending).toEqual(reply);
});

test.each(['before', 'during'] as const)('cancels %s the scripted wait', async (when) => {
  const wait = createMockLatch();
  const controller = new AbortController();
  const reason = new Error('Cancelled by the test.');
  const model = new MockDecisionModel([{ answers: { route: { value: 'ask' } }, wait }]);
  if (when === 'before') controller.abort(reason);
  const pending = model.decide(request, { ...options, signal: controller.signal });
  const rejected = expect(pending).rejects.toBe(reason);
  if (when === 'during') {
    await wait.entered;
    controller.abort(reason);
  }
  await rejected;
  wait.release();
});
