// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type DecisionResult,
  GalaxieError,
  type InteractionRequest,
  type Submission,
} from '@galaxie-ai/core';
import type { LangGraphRunnableConfig } from '@langchain/langgraph/web';
import { requestInteraction } from './interaction.js';

export interface DecisionGate {
  /** Trusted host configuration: finite and in [0, 1], never state, model or tool output. */
  readonly threshold: number;
  /** Question names whose confidence is checked. Default: every answered question. */
  readonly questions?: readonly string[];
  /** Host-authored request; must not embed answers, state or model text. */
  readonly interaction: InteractionRequest;
}

export interface GatedDecision {
  readonly answers: DecisionResult['answers'];
  readonly asked: boolean;
  readonly submission?: Submission;
}

function invalid(): never {
  throw new GalaxieError('invalid', 'The decision gate is invalid.');
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function confidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function data(value: object, key: PropertyKey): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field !== undefined && 'value' in field ? field.value : undefined;
}

/** Detach JSON data without invoking accessors or retaining mutable nested values. */
function copy(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
  if (typeof value !== 'object' || ancestors.has(value)) return invalid();
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) return invalid();
  ancestors.add(value);
  const fields: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
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
  if (array && fields.length !== value.length) return invalid();
  ancestors.delete(value);
  return Object.freeze(array ? fields.map(([, child]) => child) : Object.fromEntries(fields));
}

/**
 * Adds a user question when any checked confidence is missing or below the host threshold.
 * Never removes, skips or satisfies a capability/host confirmation, approval or consent
 * prompt, and never calls a capability. Keep the decision call and this gate in SEPARATE
 * graph nodes, storing answers in state: LangGraph re-runs an interrupted node from its
 * start on resume, so combining them leases the model again.
 */
export function gateDecision(
  answers: DecisionResult['answers'],
  gate: DecisionGate,
  config: LangGraphRunnableConfig,
): GatedDecision {
  let snapshot: DecisionResult['answers'];
  let interaction: InteractionRequest;
  let asks: boolean;
  try {
    if (gate === null || typeof gate !== 'object') return invalid();
    const threshold = data(gate, 'threshold');
    const questions = data(gate, 'questions');
    const request = data(gate, 'interaction');
    if (
      !confidence(threshold) ||
      request === null ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      (questions !== undefined &&
        (!Array.isArray(questions) ||
          questions.length === 0 ||
          new Set(questions).size !== questions.length ||
          [...questions].some(
            (name: unknown) =>
              typeof name !== 'string' ||
              answers === null ||
              typeof answers !== 'object' ||
              !Object.hasOwn(answers, name),
          )))
    )
      return invalid();
    if (!plain(answers)) return invalid();
    const names = Object.getOwnPropertyNames(answers);
    const checked: readonly string[] = questions ?? names;
    const entries: [string, unknown][] = [];
    for (const name of names) {
      const answer = data(answers, name);
      if (!plain(answer)) return invalid();
      const fields: [string, unknown][] = [];
      for (const key of Reflect.ownKeys(answer)) {
        if (key === 'confidence') {
          const score = data(answer, key);
          if (confidence(score)) fields.push([key, score]);
        } else {
          const field = Object.getOwnPropertyDescriptor(answer, key);
          if (typeof key !== 'string' || field?.enumerable !== true || !('value' in field))
            return invalid();
          fields.push([key, copy(field.value)]);
        }
      }
      entries.push([name, Object.freeze(Object.fromEntries(fields))]);
    }
    snapshot = Object.freeze(Object.fromEntries(entries)) as DecisionResult['answers'];
    asks = checked.some((name) => {
      const answer = snapshot[name];
      const score = answer === undefined ? undefined : data(answer, 'confidence');
      return !confidence(score) || score < threshold;
    });
    interaction = request as InteractionRequest;
  } catch {
    return invalid();
  }
  return asks
    ? { answers: snapshot, asked: true, submission: requestInteraction(interaction, config) }
    : { answers: snapshot, asked: false };
}
