// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError, toErrorInfo } from './errors.js';
import type { ModelUsage } from './models.js';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Bounded questions; scores are advisory model judgments, never authorizations. */
export type DecisionQuestion =
  | { readonly type: 'boolean'; readonly instructions: string }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly options: Readonly<Record<string, string>>;
      readonly multiple?: boolean;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      readonly min: number;
      readonly max: number;
    };

export interface DecisionRequest {
  readonly state: Json;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export interface DecisionAnswer {
  readonly value: boolean | string | readonly string[] | number;
  readonly probabilities?: Readonly<
    Record<string, number | { readonly yes: number; readonly no: number }>
  >;
  readonly confidence?: number;
}

export interface DecisionResult {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage?: ModelUsage;
  /** Unvalidated generated text for output checks and repair only; never publish or store. */
  readonly raw?: string;
}

export interface DecisionModelOptions {
  readonly signal: AbortSignal;
  readonly maxTokens: number;
  readonly repair?: { readonly attempt: number; readonly reply: string };
}

/** Framework-neutral inference; one call uses the route's existing lease and reservation. */
export interface DecisionModel {
  decide(request: DecisionRequest, options: DecisionModelOptions): Promise<DecisionResult>;
}

/** Credentials enter only a call-scoped factory, never request state or options. */
export type DecisionProvider =
  | DecisionModel
  | ((options: { readonly credential: string }) => DecisionModel);

function invalid(): never {
  throw new GalaxieError('invalid', toErrorInfo('invalid').message);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Detach data without invoking accessors, toJSON hooks or non-JSON coercions. */
function copy(value: unknown, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
  if (typeof value !== 'object') return invalid();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null) ||
    ancestors.has(value)
  )
    return invalid();
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return invalid();
  const fields: [string, Json][] = [];
  for (const key of keys) {
    if (array && key === 'length') continue;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      field?.enumerable !== true ||
      !('value' in field) ||
      (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))
    )
      return invalid();
    fields.push([key, copy(field.value, ancestors)]);
  }
  ancestors.delete(value);
  return Object.freeze(array ? fields.map(([, child]) => child) : Object.fromEntries(fields));
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function named(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(
    (key) => key.trim().length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key),
  );
}

/** Validate the entire request, returning a detached immutable snapshot or a fixed error. */
export function validateDecisionRequest(value: unknown): DecisionRequest {
  try {
    const request = copy(value);
    if (!object(request) || !keys(request, ['state', 'questions'])) return invalid();
    const questions = request['questions'];
    if (
      !object(questions) ||
      !named(questions) ||
      Object.keys(questions).length < 1 ||
      Object.keys(questions).length > 16
    )
      return invalid();
    for (const question of Object.values(questions)) {
      if (
        !object(question) ||
        typeof question['instructions'] !== 'string' ||
        question['instructions'].trim().length === 0
      )
        return invalid();
      switch (question['type']) {
        case 'boolean':
          if (!keys(question, ['type', 'instructions'])) return invalid();
          break;
        case 'choice': {
          const options = question['options'];
          if (
            !keys(question, ['type', 'instructions', 'options'], ['multiple']) ||
            !object(options) ||
            !named(options) ||
            Object.keys(options).length < 2 ||
            !Object.values(options).every((description) => typeof description === 'string') ||
            (Object.hasOwn(question, 'multiple') && typeof question['multiple'] !== 'boolean')
          )
            return invalid();
          break;
        }
        case 'score': {
          const min = question['min'];
          const max = question['max'];
          if (
            !keys(question, ['type', 'instructions', 'min', 'max']) ||
            typeof min !== 'number' ||
            typeof max !== 'number' ||
            !Number.isSafeInteger(min) ||
            !Number.isSafeInteger(max) ||
            max - min < 1 ||
            max - min > 9
          )
            return invalid();
          break;
        }
        default:
          return invalid();
      }
    }
    return request as unknown as DecisionRequest;
  } catch {
    return invalid();
  }
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value: unknown, names: readonly string[]): boolean {
  if (!object(value) || !keys(value, names)) return false;
  let sum = 0;
  for (const name of names) {
    const p = value[name];
    if (!probability(p)) return false;
    sum += p;
  }
  return sum >= 1 - 0.000001 && sum <= 1 + 0.000001;
}

function answerMatches(question: DecisionQuestion, answer: Record<string, unknown>): boolean {
  const value = answer['value'];
  const probabilities = answer['probabilities'];
  const supplied = Object.hasOwn(answer, 'probabilities');
  if (
    !keys(answer, ['value'], ['probabilities', 'confidence']) ||
    (Object.hasOwn(answer, 'confidence') && !probability(answer['confidence']))
  )
    return false;
  if (question.type === 'boolean')
    return typeof value === 'boolean' && (!supplied || distribution(probabilities, ['yes', 'no']));
  if (question.type === 'score')
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= question.min &&
      value <= question.max &&
      (!supplied ||
        distribution(
          probabilities,
          Array.from({ length: question.max - question.min + 1 }, (_, i) =>
            String(question.min + i),
          ),
        ))
    );
  const names = Object.keys(question.options);
  if (!question.multiple)
    return (
      typeof value === 'string' &&
      names.includes(value) &&
      (!supplied || distribution(probabilities, names))
    );
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((option: unknown) => typeof option === 'string' && names.includes(option)) &&
    (!supplied ||
      (object(probabilities) &&
        keys(probabilities, names) &&
        names.every((name) => distribution(probabilities[name], ['yes', 'no']))))
  );
}

/** No partial answers escape: every name, value and optional distribution must be valid. */
export function validateDecisionAnswers(
  request: DecisionRequest,
  value: unknown,
): DecisionResult['answers'] {
  try {
    const validated = validateDecisionRequest(request);
    const answers = copy(value);
    if (!object(answers) || !keys(answers, Object.keys(validated.questions))) return invalid();
    for (const [name, question] of Object.entries(validated.questions)) {
      const answer = answers[name];
      if (!object(answer) || !answerMatches(question, answer)) return invalid();
    }
    return answers as unknown as DecisionResult['answers'];
  } catch {
    return invalid();
  }
}
