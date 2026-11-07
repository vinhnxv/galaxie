// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Probe/load/dispose/reload and observation pattern adapted from
// spikes/b-local-inference/src/harness.ts. Decision answers stay in memory only.
import { BuiltinArm } from './arms/builtin-ai.js';
import { missingContract } from './arms/ort-candidate.js';
import { ARM_IDS, type Arm, ArmFailure, type ArmId, type DecisionReply } from './arms/types.js';
import { batches, SIMULATED_ROW_TOKENS, stateFixture } from './packing.js';
import { type Answer, type Question, questions, validateAnswers } from './questions.js';
import {
  type ArmResult,
  CHECK_NAMES,
  type Check,
  inventory,
  notMeasured,
  type Profile,
  type Reason,
  type Results,
  resultsSchema,
  type Trial,
} from './results.js';
import { ece, type Scored, scoreAccuracy, summarize } from './stats.js';

export interface Reference {
  candidateId: string;
  revision: string;
  answers: { id: string; value: Answer['value'] }[];
}
export type Observations = Map<ArmId, Answer[]>;
const inventoryIds: Record<Exclude<ArmId, 'mock'>, string> = {
  'builtin-ai': 'builtin-ai',
  watersheep: 'watersheep-0.1.0',
  laya: 'laya-english-q4',
  d1: 'd1-2b-onnx',
};
function check(passed: boolean): Check {
  return {
    status: passed ? 'passed' : 'failed',
    reason: passed ? 'observed' : 'unexpected_behavior',
  };
}
function pending(reason: Check['reason']): ArmResult['functionalChecks'] {
  return Object.fromEntries(
    CHECK_NAMES.map((name) => [name, { status: 'not_run', reason }]),
  ) as ArmResult['functionalChecks'];
}
export function emptyResult(arm: Arm, profile: Profile): ArmResult {
  const inventoryId = arm.id === 'mock' ? null : inventoryIds[arm.id];
  const pinned = inventory.find((entry) => entry.id === inventoryId);
  return {
    id: arm.id,
    evidence: arm.id === 'mock' ? 'mock-harness' : 'device-demonstration',
    profile,
    status: 'not_run',
    reason: 'not_selected',
    availability: { status: 'unavailable', reason: 'not_run', raw: null },
    inventory: pinned
      ? {
          id: pinned.id,
          revision: pinned.revision,
          files: pinned.files.map((file) => ({
            path: file.path,
            status: 'not_run',
            actualBytes: null,
            computedDigest: null,
            downloaded: null,
          })),
        }
      : null,
    download: notMeasured('not_selected'),
    loadWarm: notMeasured('not_selected'),
    runtime: null,
    runtimeReason: 'not_run',
    firstDecision: notMeasured('not_selected'),
    native30QuestionExperiment: notMeasured('not_run'),
    gpuMemory: {
      source: 'manual',
      unit: 'MiB',
      modelAlone: null,
      withChatModel: null,
      status: 'not_measured',
      note: 'Read OS or Chrome task manager; see README manual GPU procedure. Never estimated.',
    },
    accuracy: notMeasured('not_selected'),
    ece: notMeasured('not_selected'),
    agreement: notMeasured('reference_not_run'),
    builtinAiBaseline: notMeasured(arm.id === 'builtin-ai' ? 'not_selected' : 'not_applicable'),
    functionalChecks: pending('not_selected'),
  };
}
export async function probeArms(arms: Arm[], profile: Profile): Promise<ArmResult[]> {
  const results: ArmResult[] = [];
  for (const arm of arms) {
    const result = emptyResult(arm, profile);
    try {
      result.availability = await arm.probe();
    } catch {
      result.availability = { status: 'unavailable', reason: 'probe_failed', raw: null };
    }
    if (result.availability.status === 'unavailable') {
      result.status = 'unavailable';
      result.reason = result.availability.reason;
    } else if (arm.id === 'watersheep' || arm.id === 'laya' || arm.id === 'd1') {
      result.status = 'inference_not_implemented';
      result.reason = missingContract[arm.id];
    }
    results.push(result);
  }
  return results;
}
async function safeCheck(run: () => Promise<boolean>): Promise<Check> {
  try {
    return check(await run());
  } catch {
    return { status: 'failed', reason: 'check_exception' };
  }
}
async function rejects(arm: Arm, state: string, selected: Question[]): Promise<boolean> {
  try {
    await arm.decide({ state, questions: selected }, new AbortController().signal);
    return false;
  } catch (error) {
    return error instanceof ArmFailure && error.reason === 'input_rejected';
  }
}
async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function functionalChecks(arm: Arm, result: ArmResult): Promise<void> {
  const one = questions.slice(0, 1);
  result.functionalChecks.cancels = await safeCheck(async () => {
    const controller = new AbortController();
    const pending = arm.decide(
      { state: 'Synthetic cancellation fixture.', questions: one },
      controller.signal,
    );
    // A queued worker request must settle on abort, then a fresh request must work.
    controller.abort();
    let aborted = false;
    try {
      await deadline(pending, 2000);
    } catch (error) {
      aborted =
        (error instanceof ArmFailure && error.reason === 'aborted') ||
        (error instanceof DOMException && error.name === 'AbortError');
    }
    if (!aborted) return false;
    const next = await deadline(
      arm.decide(
        { state: 'Synthetic follow-up fixture.', questions: one },
        new AbortController().signal,
      ),
      30_000,
    );
    validateAnswers(one, next.answers);
    return true;
  });
  result.functionalChecks.rejectsOversize = await safeCheck(() =>
    rejects(arm, 'Synthetic boundary fixture.', questions.slice(0, 17)),
  );
  result.functionalChecks.rejectsOverlength = await safeCheck(() =>
    rejects(arm, 'long'.repeat(SIMULATED_ROW_TOKENS + 1), one),
  );
  result.functionalChecks.answerTypes = await safeCheck(async () => {
    const selected = ['boolean', 'choice', 'score']
      .map((type) => questions.find((question) => question.type === type))
      .filter((question): question is Question => Boolean(question));
    const reply = await arm.decide(
      { state: 'Synthetic type fixture; not scored.', questions: selected },
      new AbortController().signal,
    );
    validateAnswers(selected, reply.answers);
    return (
      selected.length === 3 &&
      (arm.id !== 'mock' || reply.executedIn === 'DedicatedWorkerGlobalScope')
    );
  });
  if (arm.id === 'mock') {
    result.functionalChecks.packing0 = await safeCheck(() =>
      rejects(arm, 'Synthetic boundary fixture.', []),
    );
    for (const size of [1, 16] as const)
      result.functionalChecks[size === 1 ? 'packing1' : 'packing16'] = await safeCheck(async () => {
        await arm.decide(
          { state: 'Synthetic boundary fixture.', questions: questions.slice(0, size) },
          new AbortController().signal,
        );
        return true;
      });
    // rejectsOversize owns the 17-question boundary; do not duplicate its pass/fail result.
  } else
    for (const name of ['packing0', 'packing1', 'packing16'] as const)
      result.functionalChecks[name] = { status: 'not_run', reason: 'mock_only' };
}
async function trial(arm: Arm, tokens: 200 | 1000, questionCount: 10 | 30): Promise<Trial> {
  const state = stateFixture(tokens);
  const start = performance.now();
  const requests: Trial['requests'] = [];
  for (const selected of batches(questions.slice(0, questionCount))) {
    const requestStart = performance.now();
    const reply = await arm.decide({ state, questions: selected }, new AbortController().signal);
    validateAnswers(selected, reply.answers);
    requests.push({
      questionCount: selected.length,
      tokenizationMs: reply.tokenizationMs,
      endToEndMs: performance.now() - requestStart,
      stateTokens: reply.tokenSource === 'unavailable' ? null : reply.stateTokens,
      inputTokens: reply.tokenSource === 'unavailable' ? null : reply.inputTokens,
      tokenSource: reply.tokenSource,
    });
  }
  return {
    evidence: arm.id === 'mock' ? 'mock-harness' : 'device-demonstration',
    requests,
    aggregate: {
      tokenizationMs: requests.reduce((sum, request) => sum + request.tokenizationMs, 0),
      endToEndMs: performance.now() - start,
    },
    repeatedState: {
      processedTimes: requests.length,
      extraPasses: requests.length - 1,
      extraTokens: requests.some((request) => request.stateTokens === null)
        ? null
        : requests.slice(1).reduce((sum, request) => sum + (request.stateTokens ?? 0), 0),
    },
  };
}
async function latency(arm: Arm, runs: number): Promise<ArmResult['firstDecision']> {
  const value: Extract<ArmResult['firstDecision'], { status: 'measured' }>['value'] = [];
  for (const tokens of [200, 1000] as const)
    for (const questionCount of [10, 30] as const) {
      const warmup = await trial(arm, tokens, questionCount);
      const measured: Trial[] = [];
      for (let index = 0; index < runs; index++)
        measured.push(await trial(arm, tokens, questionCount));
      value.push({
        targetStateTokens: tokens,
        questionCount,
        packing: 'explicit_caller_requests_max_16',
        warmup,
        runs: measured,
        summary: {
          tokenizationMs: summarize(measured.map((run) => run.aggregate.tokenizationMs)),
          endToEndMs: summarize(measured.map((run) => run.aggregate.endToEndMs)),
        },
      });
    }
  return { status: 'measured', value };
}
function score(result: ArmResult, answers: Answer[]): void {
  const rows: Scored[] = questions.map((question) => {
    const answer = answers.find((answer) => answer.id === question.id);
    if (!answer) throw new ArmFailure('invalid_answers');
    return { question, answer };
  });
  result.accuracy = {
    status: 'measured',
    value: (['calibration', 'evaluation'] as const).map((split) => {
      const selected = rows.filter((row) => row.question.split === split);
      return {
        split,
        overall: scoreAccuracy(selected),
        byDomain: (['tutor', 'support', 'write-confirmation', 'privacy'] as const).map(
          (domain) => ({
            domain,
            ...scoreAccuracy(selected.filter((row) => row.question.domain === domain)),
          }),
        ),
        byType: (['boolean', 'choice', 'score'] as const).map((type) => ({
          type,
          ...scoreAccuracy(selected.filter((row) => row.question.type === type)),
        })),
      };
    }),
  };
  result.ece = {
    status: 'measured',
    value: (['calibration', 'evaluation'] as const).map((split) => ({
      split,
      calibration: ece(rows.filter((row) => row.question.split === split)),
    })),
  };
}
export function applyReference(
  result: ArmResult,
  answers: Answer[] | undefined,
  reference: Reference | null,
): void {
  if (!reference) {
    result.agreement = notMeasured('reference_not_run');
    return;
  }
  const identity =
    result.id === 'mock' ? { id: 'deterministic-mock', revision: 'v1' } : result.inventory;
  if (
    !identity ||
    reference.candidateId !== identity.id ||
    reference.revision !== identity.revision
  ) {
    result.agreement = notMeasured('reference_candidate_mismatch');
    return;
  }
  if (!answers) {
    result.agreement = notMeasured('inference_not_implemented');
    return;
  }
  const agreed = reference.answers.filter(
    (answer) => answers.find((observed) => observed.id === answer.id)?.value === answer.value,
  ).length;
  result.agreement = {
    status: 'measured',
    value: {
      referenceId: reference.candidateId,
      revision: reference.revision,
      count: reference.answers.length,
      agreed,
      fraction: agreed / reference.answers.length,
    },
  };
}
export async function runArm(
  arm: Arm,
  result: ArmResult,
  options: {
    runs: number;
    probeOnly: boolean;
    progress(message: string): void;
    beforeDispose?(result: ArmResult): Promise<void>;
  },
  observations: Observations,
): Promise<void> {
  const dedicated = arm.id === 'watersheep' || arm.id === 'laya' || arm.id === 'd1';
  const skip: Reason | null =
    result.availability.status === 'unavailable'
      ? (result.availability.reason ?? 'probe_failed')
      : options.probeOnly && arm.id !== 'mock'
        ? 'probe_only'
        : null;
  if (skip) {
    result.download =
      result.loadWarm =
      result.firstDecision =
      result.accuracy =
      result.ece =
        notMeasured(skip);
    result.functionalChecks = pending(skip === 'probe_only' ? 'probe_only' : 'arm_unavailable');
    return;
  }
  try {
    const progress = (loaded: number, total: number | null): void =>
      options.progress(`${arm.id}: ${loaded} / ${total ?? 'unknown'} bytes`);
    const first = await arm.load(progress);
    result.download =
      first.downloadMs === null
        ? notMeasured(first.downloadReason ?? 'not_run')
        : { status: 'measured', value: first.downloadMs };
    if (result.inventory) result.inventory.files = first.files;
    result.runtime = first.runtime;
    await arm.dispose();
    const second = await arm.load(progress);
    result.loadWarm = { status: 'measured', value: second.loadMs };
    // Keep cold-download flags while taking the union of both verified file snapshots.
    if (result.inventory)
      result.inventory.files = second.files.map((file) => ({
        ...file,
        downloaded:
          first.files.find((cold) => cold.path === file.path)?.downloaded ?? file.downloaded,
      }));
    result.runtime = second.runtime;
    result.runtimeReason = second.runtime
      ? null
      : dedicated
        ? 'runtime_metadata_unavailable'
        : 'not_applicable';
    result.functionalChecks.loads = check(true);
    if (dedicated) {
      result.status = 'inference_not_implemented';
      result.reason = missingContract[arm.id as 'watersheep' | 'laya' | 'd1'];
      result.firstDecision = result.accuracy = result.ece = notMeasured(result.reason);
      for (const name of CHECK_NAMES)
        if (name !== 'loads')
          result.functionalChecks[name] = {
            status: 'not_run',
            reason: 'inference_not_implemented',
          };
      await options.beforeDispose?.(result);
      return;
    }
    await functionalChecks(arm, result);
    try {
      result.firstDecision = await latency(arm, options.runs);
    } catch (error) {
      result.firstDecision = notMeasured(
        error instanceof ArmFailure ? error.reason : 'invalid_answers',
      );
    }
    const answers: Answer[] = [];
    for (const question of questions) {
      const reply: DecisionReply = await arm.decide(
        { state: question.state, questions: [question] },
        new AbortController().signal,
      );
      validateAnswers([question], reply.answers);
      answers.push(...reply.answers);
    }
    score(result, answers);
    observations.set(arm.id, answers);
    result.status = 'completed';
    result.reason = null;
  } catch (error) {
    result.status = 'failed';
    result.reason = error instanceof ArmFailure ? error.reason : 'load_failed';
    if (error instanceof ArmFailure && result.inventory)
      for (const file of error.files) {
        const existing = result.inventory.files.findIndex((item) => item.path === file.path);
        if (existing < 0) result.inventory.files.push(file);
        else result.inventory.files[existing] = file;
      }
    if (result.functionalChecks.loads.status === 'not_run') {
      result.functionalChecks = pending('load_failed');
      result.functionalChecks.loads = check(false);
      result.download = result.loadWarm = notMeasured(result.reason);
    }
    result.firstDecision = result.accuracy = result.ece = notMeasured(result.reason);
  } finally {
    await arm.dispose().catch(() => {});
    if (arm instanceof BuiltinArm)
      result.builtinAiBaseline = arm.baseline(result.profile.browserVersion);
  }
}
export function selectedArms(value: string | null): ArmId[] {
  return value === null
    ? ['mock']
    : [
        ...new Set(
          value.split(',').filter((id): id is ArmId => (ARM_IDS as readonly string[]).includes(id)),
        ),
      ];
}
export function makeResults(
  profile: Profile,
  arms: ArmResult[],
  order: ArmId[],
  runs: number,
): Results {
  return resultsSchema.parse({
    schema: 'galaxie.spike-decision-models.results/v1',
    createdAt: new Date().toISOString(),
    runs,
    profile,
    inventory,
    questionSet: {
      id: 'galaxie.spike-decision-models.questions/v1',
      count: 200,
      calibrationCount: 100,
      evaluationCount: 100,
      eceBins: 10,
      minimumPerBin: 10,
      seed: 20261107,
    },
    armOrder: order,
    arms,
  });
}
