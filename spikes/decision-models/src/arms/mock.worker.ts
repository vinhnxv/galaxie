// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { approximateTokens, rowTokens, validateRequest } from '../packing.js';
import type { Answer, Question, Value } from '../questions.js';
import { ArmFailure, type DecisionReply, type DecisionRequest, type LoadRecord } from './types.js';
import { serveWorker } from './worker-rpc.js';

let failure: string | null = null;
let noConfidence = false;
let loaded = false;
function hash(id: string): number {
  let value = 20261107;
  for (const character of id) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
}
function wrong(question: Question): Value {
  if (question.type === 'boolean') return !question.label;
  if (question.type === 'score') return (question.label % question.options.levels) + 1;
  return Object.keys(question.options).find((key) => key !== question.label) ?? question.label;
}
function answer(question: Question): Answer {
  const seed = hash(question.id);
  return {
    id: question.id,
    value: seed % 7 === 0 ? wrong(question) : question.label,
    confidence: noConfidence ? null : ([0.35, 0.55, 0.72, 0.92][seed % 4] ?? 0.5),
  };
}
function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new ArmFailure('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 3);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
serveWorker({
  async load(value): Promise<LoadRecord> {
    const options = value as { failure: string | null; noConfidence: boolean };
    failure = options.failure;
    noConfidence = options.noConfidence;
    loaded = true;
    return {
      downloadMs: null,
      downloadReason: 'mock_no_download',
      loadMs: 0,
      files: [],
      runtime: null,
    };
  },
  async decide(value, signal): Promise<DecisionReply> {
    if (!loaded) throw new ArmFailure('inference_failed');
    const request = value as DecisionRequest;
    const start = performance.now();
    try {
      validateRequest(request.state, request.questions, failure === 'no-reject-oversize');
    } catch {
      throw new ArmFailure('input_rejected');
    }
    const inputTokens = rowTokens(request.state, request.questions);
    const stateTokens = approximateTokens(request.state);
    const tokenizationMs = performance.now() - start;
    await delay(signal);
    // Failure injection changes only normal answer completeness, leaving rejection checks intact.
    const selected =
      failure === 'truncate' && request.questions.length > 1
        ? request.questions.slice(0, -1)
        : request.questions;
    return {
      answers: selected.map(answer),
      tokenizationMs,
      stateTokens,
      inputTokens,
      tokenSource: 'mock_approximation',
      generatedTokens: 0,
      executedIn: globalThis.constructor.name,
    };
  },
  async dispose(): Promise<void> {
    loaded = false;
  },
});
