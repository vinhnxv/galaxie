// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  type ErrorCode,
  GalaxieError,
  isGalaxieError,
  type ModelPort,
  type ModelUsage,
  type TraceHandle,
  toErrorInfo,
  validateDecisionAnswers,
  validateDecisionRequest,
} from '@galaxie/core';
import type { LangGraphRunnableConfig } from '@langchain/langgraph/web';
import type { LangGraphTraceHandler } from './trace-handler.js';

interface ActiveRun {
  readonly models: ModelPort;
  readonly handler: LangGraphTraceHandler;
  readonly signal?: AbortSignal;
  readonly payload?: (value: unknown) => string;
}

function failure(code: ErrorCode): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}

/** Never read a provider accessor, including usage; malformed usage charges the reservation. */
function result(value: unknown): {
  readonly answers: unknown;
  readonly usage?: ModelUsage;
  readonly raw?: string;
} {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).some((key) => key !== 'answers' && key !== 'usage' && key !== 'raw')
    )
      throw failure('invalid');
    const answersField = Object.getOwnPropertyDescriptor(value, 'answers');
    if (answersField === undefined || !('value' in answersField)) throw failure('invalid');
    const rawField = Object.getOwnPropertyDescriptor(value, 'raw');
    if (rawField !== undefined && (!('value' in rawField) || typeof rawField.value !== 'string'))
      throw failure('invalid');
    const raw = rawField?.value as string | undefined;
    const field = Object.getOwnPropertyDescriptor(value, 'usage');
    let usage: ModelUsage | undefined;
    if (
      field !== undefined &&
      'value' in field &&
      typeof field.value === 'object' &&
      field.value !== null
    ) {
      const input = Object.getOwnPropertyDescriptor(field.value, 'inputTokens')?.value as unknown;
      const output = Object.getOwnPropertyDescriptor(field.value, 'outputTokens')?.value as unknown;
      if (
        typeof input === 'number' &&
        Number.isFinite(input) &&
        Number.isInteger(input) &&
        input >= 0 &&
        typeof output === 'number' &&
        Number.isFinite(output) &&
        Number.isInteger(output) &&
        output >= 0
      )
        usage = { inputTokens: input, outputTokens: output };
    }
    return {
      answers: answersField.value,
      ...(usage === undefined ? {} : { usage }),
      ...(raw === undefined ? {} : { raw }),
    };
  } catch {
    throw failure('invalid');
  }
}

async function wait<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) throw failure('cancelled');
  let abort = (): void => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(failure('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** One atomic decision behind the active run's policy, payload budget and output checks. */
export async function routedDecision(
  role: string,
  input: DecisionRequest,
  config: LangGraphRunnableConfig | undefined,
  providers: Readonly<Record<string, DecisionProvider>>,
  run: ActiveRun | undefined,
): Promise<DecisionResult['answers']> {
  if (run === undefined) throw failure('invalid');
  const signal = AbortSignal.any([
    ...(run.signal === undefined ? [] : [run.signal]),
    ...(config?.signal === undefined ? [] : [config.signal]),
  ]);
  const assertActive = (): void => {
    if (signal.aborted) throw failure('cancelled');
  };
  assertActive();
  const request = validateDecisionRequest(input);
  if (run.payload === undefined) throw failure('unavailable');
  run.payload(request);
  let repair: { readonly attempt: number; readonly reply: string } | undefined;
  for (;;) {
    assertActive();
    // begin rejects exhausted route allowances before reserving a shared repair or model call.
    const lease = await run.models.begin(role, {
      signal,
      ...(repair === undefined ? {} : { repairAttempt: repair.attempt }),
    });
    let settled = false;
    let successful = false;
    let reported: ModelUsage | undefined;
    let trace: TraceHandle | undefined;
    try {
      const callbacks = config?.callbacks;
      const parent =
        callbacks !== undefined &&
        !Array.isArray(callbacks) &&
        'getParentRunId' in callbacks &&
        typeof callbacks.getParentRunId === 'function'
          ? callbacks.getParentRunId()
          : undefined;
      trace = run.handler.startDecision(lease, parent);
      assertActive();
      const implementation = Object.hasOwn(providers, lease.providerId)
        ? providers[lease.providerId]
        : undefined;
      if (implementation === undefined) throw failure('unavailable');
      if (typeof implementation === 'function' && lease.credential === undefined)
        throw failure('invalid');
      const provider =
        typeof implementation === 'function'
          ? implementation({ credential: lease.credential as string })
          : implementation;
      assertActive();
      const reply = await wait(
        Promise.resolve().then(() => {
          assertActive();
          return provider.decide(request, {
            signal,
            maxTokens: lease.maxTokens,
            ...(repair === undefined ? {} : { repair }),
          });
        }),
        signal,
      );
      assertActive();
      const received = result(reply);
      if (received.raw !== undefined) {
        await lease.checkOutput(received.raw, { final: true });
        assertActive();
      }
      let answers: DecisionResult['answers'];
      try {
        answers = validateDecisionAnswers(request, received.answers);
      } catch {
        // The call completed: settle reported usage even when its answers are invalid.
        reported = received.usage;
        settled = true;
        lease.end(reported);
        assertActive();
        if (received.raw === undefined) throw failure('invalid');
        repair = { attempt: (repair?.attempt ?? 0) + 1, reply: received.raw };
        continue;
      }
      const json = run.payload(answers);
      await lease.checkOutput(json, { final: true });
      assertActive();
      reported = received.usage;
      settled = true;
      lease.end(reported);
      assertActive();
      successful = true;
      return answers;
    } catch (error) {
      const code = isGalaxieError(error) ? error.code : undefined;
      throw failure(
        code === 'budget_exceeded' ? code : signal.aborted ? 'cancelled' : (code ?? 'unavailable'),
      );
    } finally {
      if (!settled) lease.fail();
      trace?.end({
        status: successful ? 'ok' : 'error',
        route: { providerId: lease.providerId, destination: lease.destination },
        ...(reported === undefined ? {} : { usage: reported }),
        ...(lease.outputSafetyOutcome === undefined
          ? {}
          : { outputSafetyOutcome: lease.outputSafetyOutcome }),
      });
    }
  }
}
