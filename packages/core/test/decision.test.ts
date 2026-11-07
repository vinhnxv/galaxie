// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { budgetLimits, RunBudget } from '../src/budgets.js';
import {
  type DecisionRequest,
  validateDecisionAnswers,
  validateDecisionRequest,
} from '../src/decision.js';
import { toErrorInfo } from '../src/errors.js';

const boolean = { type: 'boolean', instructions: 'Check the state.' } as const;
const choice = {
  type: 'choice',
  instructions: 'Choose a route.',
  options: { ask: 'Ask', answer: 'Answer' },
} as const;
const request: DecisionRequest = {
  state: { text: 'private-state-canary', nested: [null, true, 12] },
  questions: {
    safe: boolean,
    route: choice,
    tags: { ...choice, multiple: true },
    score: { type: 'score', instructions: 'Rate relevance.', min: -1, max: 1 },
  },
};
const answers = {
  safe: { value: true, probabilities: { yes: 0.7, no: 0.3 }, confidence: 0.8 },
  route: { value: 'ask', probabilities: { ask: 0.75, answer: 0.25 } },
  tags: {
    value: ['ask', 'answer'],
    probabilities: { ask: { yes: 0.9, no: 0.1 }, answer: { yes: 0.8, no: 0.2 } },
  },
  score: { value: 0, probabilities: { '-1': 0.1, '0': 0.8, '1': 0.1 }, confidence: 0 },
};
const invalid = { code: 'invalid', message: toErrorInfo('invalid').message };

test('all bounded question types accept complete independent optional evidence', () => {
  const validated = validateDecisionRequest(request);
  expect(validated).toEqual(request);
  expect(validated).not.toBe(request);
  expect(Object.isFrozen(validated.questions)).toBe(true);
  const result = validateDecisionAnswers(validated, answers);
  expect(result).toEqual(answers);
  expect(result).not.toBe(answers);
  expect(Object.isFrozen(result['safe'])).toBe(true);
  expect(
    validateDecisionAnswers(request, {
      safe: { value: false },
      route: { value: 'answer', confidence: 1 },
      tags: { value: [] },
      score: { value: -1 },
    }),
  ).toMatchObject({ tags: { value: [] } });
});

test.each(
  [null, true, false, 1, 0, '', 'text', [], {}, Object.create(null)].map((state) => ({ state })),
)('accepts JSON state %#', ({ state }) => {
  expect(validateDecisionRequest({ state, questions: { check: boolean } }).state).toEqual(state);
});

const cyclic: unknown[] = [];
cyclic.push(cyclic);
const getter = vi.fn(() => 'private-accessor-canary');
const accessor = Object.defineProperty({}, 'text', { enumerable: true, get: getter });
const arrayAccessor = Object.defineProperty([0], '0', { enumerable: true, get: getter });
const hidden = Object.defineProperty({}, 'text', { value: 'hidden-canary' });
const extraArray = Object.assign([], { extra: true });

test.each(
  [
    undefined,
    () => {},
    Symbol('private-symbol-canary'),
    1n,
    NaN,
    Infinity,
    new Date(),
    new Map(),
    new Set(),
    cyclic,
    accessor,
    arrayAccessor,
    hidden,
    extraArray,
    Array(1),
    { bad: undefined },
    [undefined],
    { [Symbol('key')]: true },
    Object.create({ text: 'inherited' }),
  ].map((state) => ({ state })),
)('rejects non-JSON state %# without invoking code or exposing content', ({ state }) => {
  expect(() => validateDecisionRequest({ state, questions: { check: boolean } })).toThrowError(
    expect.objectContaining(invalid),
  );
  expect(getter).not.toHaveBeenCalled();
});

test.each([0, 16, 17])('question cap is exact for %s questions', (count) => {
  const value = {
    state: 'canary',
    questions: Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, boolean])),
  };
  if (count === 16) expect(Object.keys(validateDecisionRequest(value).questions)).toHaveLength(16);
  else expect(() => validateDecisionRequest(value)).toThrowError(expect.objectContaining(invalid));
});

test.each([
  { type: 'boolean', instructions: '' },
  { type: 'boolean', instructions: '  ' },
  { ...boolean, extra: 'private-question-canary' },
  { type: 'extract', instructions: 'Extract.' },
  { ...choice, options: { only: 'One' } },
  { ...choice, options: ['ask', 'answer'] },
  { ...choice, options: { ask: 1, answer: 'Answer' } },
  { ...choice, multiple: undefined },
  { ...choice, multiple: 'yes' },
  { type: 'score', instructions: 'Rate.', min: 1, max: 1 },
  { type: 'score', instructions: 'Rate.', min: 0, max: 10 },
  { type: 'score', instructions: 'Rate.', min: 1.5, max: 2 },
  { type: 'score', instructions: 'Rate.', min: 0, max: Infinity },
  {
    type: 'score',
    instructions: 'Rate.',
    min: Number.MAX_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER + 1,
  },
])('rejects invalid question %#', (question) => {
  expect(() => validateDecisionRequest({ state: null, questions: { q: question } })).toThrowError(
    expect.objectContaining(invalid),
  );
});

test.each(['', ' ', '__proto__', 'constructor', 'prototype'])(
  'rejects reserved or empty names %s',
  (name) => {
    expect(() =>
      validateDecisionRequest({ state: null, questions: { [name]: boolean } }),
    ).toThrowError(expect.objectContaining(invalid));
    expect(() =>
      validateDecisionRequest({
        state: null,
        questions: { q: { ...choice, options: { [name]: 'bad', valid: 'good' } } },
      }),
    ).toThrowError(expect.objectContaining(invalid));
  },
);

test.each([
  { questions: { q: boolean } },
  { state: null },
  { ...request, extra: true },
  { state: null, questions: [] },
  Object.defineProperty({}, 'state', { get: getter }),
])('requires exactly the request fields %#', (value) => {
  expect(() => validateDecisionRequest(value)).toThrowError(expect.objectContaining(invalid));
  expect(getter).not.toHaveBeenCalled();
});

test.each([
  {},
  { ...answers, extra: { value: 'private-reply-canary' } },
  { ...answers, safe: undefined },
  { ...answers, safe: { value: 'private-reply-canary' } },
  { ...answers, route: { value: 'unknown-private-reply-canary' } },
  { ...answers, tags: { value: ['ask', 'ask'] } },
  { ...answers, tags: { value: ['unknown'] } },
  { ...answers, tags: { value: 'ask' } },
  { ...answers, score: { value: 2 } },
  { ...answers, score: { value: 0.5 } },
  { ...answers, score: { value: NaN } },
  { ...answers, safe: { value: true, unknown: 'private-reply-canary' } },
  { ...answers, safe: { value: true, confidence: undefined } },
  { ...answers, safe: { value: true, probabilities: { yes: 1 } } },
  { ...answers, safe: { value: true, probabilities: { yes: 0.8, no: 0.3 } } },
  {
    ...answers,
    safe: { value: true, probabilities: { yes: 1, no: 0, extra: 0 } },
  },
  { ...answers, route: { value: 'ask', probabilities: { ask: 0.5 } } },
  { ...answers, score: { value: 0, probabilities: { '0': 1 } } },
  { ...answers, tags: { value: [], probabilities: { ask: { yes: 1, no: 0 } } } },
  { ...answers, tags: { value: [], probabilities: { ask: 0.5, answer: 0.5 } } },
  {
    ...answers,
    tags: {
      value: [],
      probabilities: { ask: { yes: 0.8, no: 0.3 }, answer: { yes: 1, no: 0 } },
    },
  },
])('rejects the entire answer atomically with fixed content-free errors %#', (value) => {
  let result: unknown;
  try {
    result = validateDecisionAnswers(request, value);
  } catch (error) {
    expect(error).toMatchObject(invalid);
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('canary');
  }
  expect(result).toBeUndefined();
});

test.each([NaN, Infinity, -Infinity, -0.1, 1.1])(
  'rejects non-finite and out-of-range evidence %s',
  (p) => {
    for (const evidence of [{ confidence: p }, { probabilities: { yes: p, no: 0 } }])
      expect(() =>
        validateDecisionAnswers(request, { ...answers, safe: { value: true, ...evidence } }),
      ).toThrowError(expect.objectContaining(invalid));
  },
);

test.each([1 - 0.000001, 1 + 0.000001, 1 - 0.0000011, 1 + 0.0000011])(
  'probability sums enforce inclusive tolerance at %s',
  (sum) => {
    const value = {
      ...answers,
      safe: { value: true, probabilities: { yes: 0.5, no: sum - 0.5 } },
    };
    if (sum >= 1 - 0.000001 && sum <= 1 + 0.000001)
      expect(validateDecisionAnswers(request, value)).toEqual(value);
    else
      expect(() => validateDecisionAnswers(request, value)).toThrowError(
        expect.objectContaining(invalid),
      );
  },
);

test('payload boundaries use the run budget and count UTF-8 JSON overhead for whole values', () => {
  for (const value of [
    validateDecisionRequest({ state: 'é', questions: { q: boolean } }),
    validateDecisionAnswers(request, answers),
  ]) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(new RunBudget(budgetLimits({ payloadBytes: bytes })).payload(value)).toBe(
      JSON.stringify(value),
    );
    expect(() =>
      new RunBudget(budgetLimits({ payloadBytes: bytes - 1 })).payload(value),
    ).toThrowError(expect.objectContaining({ code: 'budget_exceeded', budget: 'payloadBytes' }));
  }
});
