// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ARM_IDS,
  type Arm,
  type ArmId,
  type GenerationRequest,
  type GenerationResult,
  type Session,
} from './arms/types.js';
import { type ArmResult, CHECK_NAMES, type Check, notRun } from './results.js';
import { outputHash, summarize } from './stats.js';
import {
  codeWord,
  coverageSchema,
  probeSchema,
  resetRecall,
  resetRemember,
  schemaCoverage,
  schemaProbe,
  tasks,
  validates,
} from './tasks.js';

// A macrotask pause; requestAnimationFrame never fires in a background tab.
export function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}
function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
function probeOutcome(text: string): string {
  if (!parses(text)) return 'parse_error';
  return validates(probeSchema, text) ? 'constrained_value_observed' : 'mismatch';
}
const check = (passed: boolean, reason: string): Check => ({
  status: passed ? 'passed' : 'failed',
  reason,
});
export function armResult(arm: Arm): ArmResult {
  return {
    id: arm.id,
    model: arm.model,
    engineVersion: arm.engineVersion,
    inWorker: arm.inWorker,
    decoding: arm.decoding,
    schemaMechanism: arm.schemaMechanism,
    fallbacks: arm.fallbacks ?? [],
    sameCheckpointAs: arm.sameCheckpointAs,
    // Only the Prompt API keeps context in the engine; worker arms replay a per-session
    // history kept by the spike, so their reset check tests that history, not the engine.
    sessionIsolation: arm.id === 'prompt-api' ? 'native_session' : 'harness_history_replay',
    availability: { status: 'unavailable', reason: 'not_implemented' },
    checks: Object.fromEntries(
      CHECK_NAMES.map((name) => [name, notRun('not_started')]),
    ) as ArmResult['checks'],
    loads: [],
    coldLoadMs: null,
    coldLoadReason: null,
    warmLoadMs: null,
    download: { storageDeltaBytes: null, reportedBytes: null, reason: null },
    cancel: null,
    tasks: [],
    longTasks: { count: null, longestMs: null, reason: 'not_run' },
    error: null,
  };
}
async function storageUsage(): Promise<number | null> {
  try {
    return (await navigator.storage.estimate()).usage ?? null;
  } catch {
    return null;
  }
}
function longTasks(): { finish(): ArmResult['longTasks'] } {
  if (!PerformanceObserver.supportedEntryTypes.includes('longtask'))
    return { finish: () => ({ count: null, longestMs: null, reason: 'unsupported' }) };
  let count = 0;
  let longestMs = 0;
  const collect = (entries: PerformanceEntry[]): void => {
    for (const entry of entries) {
      count++;
      longestMs = Math.max(longestMs, entry.duration);
    }
  };
  const observer = new PerformanceObserver((list) => collect(list.getEntries()));
  observer.observe({ type: 'longtask' });
  return {
    finish: () => {
      collect(observer.takeRecords());
      observer.disconnect();
      return {
        count,
        longestMs,
        reason: null,
      };
    },
  };
}
export async function resetCheck(
  open: () => Promise<Session>,
  generate: (
    session: Session,
    request: Omit<GenerationRequest, 'signal' | 'onChunk'>,
  ) => Promise<GenerationResult>,
): Promise<Check> {
  const a = await open();
  let b: Session | undefined;
  try {
    b = await open();
    await generate(a, { messages: resetRemember, maxTokens: 64 });
    const other = await generate(b, { messages: resetRecall, maxTokens: 64 });
    const control = await generate(a, { messages: resetRecall, maxTokens: 64 });
    if (other.text.includes(codeWord)) return check(false, 'context_leaked');
    if (!control.text.includes(codeWord))
      return { status: 'not_applicable', reason: 'positive_control_failed' };
    return check(true, 'positive_control_and_isolation_observed');
  } finally {
    await a.close();
    await b?.close();
  }
}
export interface HarnessOptions {
  beforeDispose?: (arm: Arm) => Promise<void>;
  runs: number;
  probeReal: boolean;
  promptProbe: boolean;
  promptVi: string;
  progress: (message: string) => void;
}
export async function runArm(arm: Arm, options: HarnessOptions): Promise<ArmResult> {
  const result = armResult(arm);
  result.availability = await arm.probe();
  const probeOnly =
    arm.id !== 'mock' && (arm.id === 'prompt-api' ? options.promptProbe : options.probeReal);
  if (result.availability.status === 'unavailable' || probeOnly) {
    for (const name of CHECK_NAMES)
      result.checks[name] = notRun(probeOnly ? 'probe_only' : 'arm_unavailable');
    return result;
  }
  const executions: string[] = [];
  const generate = async (
    session: Session,
    request: Omit<GenerationRequest, 'signal' | 'onChunk'>,
    signal = new AbortController().signal,
    onChunk: (text: string) => void = () => {},
  ): Promise<GenerationResult> => {
    const reply = await session.generate({
      messages: request.messages,
      maxTokens: request.maxTokens,
      ...(request.schema ? { schema: request.schema } : {}),
      signal,
      onChunk,
    });
    executions.push(reply.executedIn);
    return reply;
  };
  // Timing starts after the session is open, so session creation (a full create() for the
  // Prompt API) is recorded apart from time to first token and total time.
  const once = async (
    request: Omit<GenerationRequest, 'signal' | 'onChunk'>,
    onChunk?: (text: string) => void,
    timing: { openMs: number; start: number; end: number } = { openMs: 0, start: 0, end: 0 },
  ): Promise<GenerationResult> => {
    const opened = performance.now();
    const session = await arm.openSession();
    timing.start = performance.now();
    timing.openMs = timing.start - opened;
    try {
      const reply = await generate(session, request, undefined, onChunk);
      timing.end = performance.now();
      return reply;
    } finally {
      await session.close();
    }
  };
  const safe = async (
    name: (typeof CHECK_NAMES)[number],
    run: () => Promise<Check>,
  ): Promise<void> => {
    try {
      result.checks[name] = await run();
    } catch {
      result.checks[name] = check(false, 'check_exception');
    }
  };
  try {
    const before = await storageUsage();
    for (let i = 0; i < 2; i++) {
      options.progress(`${arm.id}: load ${i + 1}`);
      const started = performance.now();
      const info = await arm.load(() => {});
      const elapsedMs = performance.now() - started;
      result.loads.push({ ...info, elapsedMs, reason: info.reason ?? null });
      result.model = { ...arm.model };
      result.sameCheckpointAs = arm.sameCheckpointAs;
      if (i === 0) {
        if (info.loadKind === 'cold') result.coldLoadMs = elapsedMs;
        else
          result.coldLoadReason =
            info.loadKind === 'warm' ? 'already_cached' : 'cache_state_unknown';
        result.download.reportedBytes = info.reportedBytes;
        const after = await storageUsage();
        result.download.storageDeltaBytes =
          before !== null && after !== null ? after - before : null;
        if (arm.id === 'prompt-api') {
          result.download.storageDeltaBytes = null;
          result.download.reason = 'browser_managed_fraction_only';
        } else if (before === null || after === null)
          result.download.reason = 'storage_estimate_unavailable';
        await arm.dispose();
      } else result.warmLoadMs = elapsedMs;
    }
    result.checks.loads = check(true, 'two_loads_completed');
    const feedback = tasks.find((task) => task.id === 'feedback-en');
    if (!feedback) throw new Error('missing_feedback_task');
    await safe('streams', async () => {
      const session = await arm.openSession();
      let chunks = 0;
      let settled = false;
      try {
        await generate(session, feedback, undefined, () => {
          if (!settled) chunks++;
        });
        settled = true;
        return check(chunks >= 2, `chunks_before_final_${chunks}`);
      } finally {
        settled = true;
        await session.close();
      }
    });
    await safe('cancels', async () => {
      const session = await arm.openSession();
      const controller = new AbortController();
      let chunks = 0;
      let after = 0;
      let settled = false;
      let abortAt: number | null = null;
      let chunksAtAbort = 0;
      let reply: GenerationResult | undefined;
      let abortRejected = false;
      try {
        try {
          reply = await generate(session, feedback, controller.signal, () => {
            chunks++;
            if (settled) after++;
            if (chunks === 2) {
              chunksAtAbort = chunks;
              abortAt = performance.now();
              controller.abort();
            }
          });
        } catch (error) {
          abortRejected = error instanceof DOMException && error.name === 'AbortError';
        }
        const settledAt = performance.now();
        settled = true;
        await pause();
        let nextSucceeded = false;
        let nextTtft: number | null = null;
        const timing = { openMs: 0, start: 0, end: 0 };
        try {
          const next = await once(
            feedback,
            () => {
              nextTtft ??= performance.now() - timing.start;
            },
            timing,
          );
          nextSucceeded = next.text.length > 0 && !next.aborted;
        } catch {}
        result.cancel = {
          chunksAtAbort,
          abortToSettleMs: abortAt === null ? null : settledAt - abortAt,
          chunksAfterSettle: after,
          nextRequestSucceeded: nextSucceeded,
          nextRequestTtftMs: nextTtft,
          medianFeedbackTtftMs: null,
        };
        const stopped = reply?.aborted === true || abortRejected;
        return check(
          abortAt !== null && stopped && after === 0 && nextSucceeded,
          abortAt === null
            ? 'no_second_chunk'
            : !stopped
              ? 'not_aborted'
              : after > 0
                ? 'chunk_after_settle'
                : !nextSucceeded
                  ? 'next_request_failed'
                  : 'abort_observed_after_second_chunk',
        );
      } finally {
        await session.close();
      }
    });
    await safe('resetPerSession', () =>
      resetCheck(
        () => arm.openSession(),
        (session, request) => generate(session, request),
      ),
    );
    await safe('schemaEnforcedWhileDecoding', async () => {
      const reply = await once(schemaProbe);
      return {
        ...check(validates(probeSchema, reply.text), probeOutcome(reply.text)),
        constrained: reply.constrained,
      };
    });
    await safe('schemaCoverage', async () => {
      const reply = await once(schemaCoverage);
      return {
        ...check(
          validates(coverageSchema, reply.text),
          parses(reply.text) ? 'coverage_probe' : 'parse_error',
        ),
        constrained: reply.constrained,
      };
    });
    for (const task of tasks) {
      const entry: ArmResult['tasks'][number] = {
        id: task.id,
        status: 'not_run',
        reason: null,
        warmupMs: null,
        runs: [],
        summary: {
          totalMs: summarize([]),
          ttftMs: summarize([]),
          length: summarize([]),
          tokensPerSecond: summarize([]),
          validRuns: task.schema ? 0 : null,
          distinctOutputs: 0,
        },
      };
      result.tasks.push(entry);
      if (
        arm.id === 'prompt-api' &&
        task.id === 'feedback-vi' &&
        options.promptVi === 'unavailable'
      ) {
        entry.reason = 'language_unsupported';
        continue;
      }
      options.progress(`${arm.id}: ${task.id}`);
      const warmup = performance.now();
      try {
        await once(task);
        entry.warmupMs = performance.now() - warmup;
      } catch {
        entry.status = 'failed';
        entry.reason = 'warmup_failed';
        result.error = 'task_failed';
        continue;
      }
      const hashes = new Set<string>();
      for (let i = 0; i < options.runs; i++) {
        const observation = longTasks();
        const timing = { openMs: 0, start: 0, end: 0 };
        let first: number | null = null;
        let reply: GenerationResult;
        try {
          reply = await once(
            task,
            () => {
              first ??= performance.now();
            },
            timing,
          );
        } catch {
          observation.finish();
          entry.reason = 'generation_failed';
          result.error = 'task_failed';
          break;
        }
        const { start, end } = timing;
        const totalMs = end - start;
        const outputTokens = reply.outputTokens;
        const unconstrained = task.id !== 'quiz';
        entry.runs.push({
          openSessionMs: timing.openMs,
          ttftMs: unconstrained && first !== null ? first - start : null,
          totalMs,
          length: outputTokens ?? reply.text.length,
          lengthUnit: outputTokens === undefined ? 'characters' : 'tokens',
          valid: task.valid(reply.text),
          constrained: reply.constrained,
          forcedTokens: reply.forcedTokens ?? null,
          modelChosenTokens: reply.modelChosenTokens ?? null,
          tokensPerSecond:
            unconstrained && outputTokens !== undefined && first !== null && end > first
              ? Math.max(0, outputTokens - 1) / ((end - first) / 1000)
              : null,
          longTasks: observation.finish(),
        });
        hashes.add(await outputHash(reply.text));
      }
      entry.status = entry.runs.length === options.runs ? 'completed' : 'failed';
      entry.summary = {
        totalMs: summarize(entry.runs.map((run) => run.totalMs)),
        ttftMs: summarize(entry.runs.map((run) => run.ttftMs)),
        length: summarize(entry.runs.map((run) => run.length)),
        tokensPerSecond: summarize(entry.runs.map((run) => run.tokensPerSecond)),
        validRuns: task.schema ? entry.runs.filter((run) => run.valid).length : null,
        distinctOutputs: hashes.size,
      };
    }
    await options.beforeDispose?.(arm);
    if (result.cancel)
      result.cancel.medianFeedbackTtftMs =
        result.tasks.find((task) => task.id === 'feedback-en')?.summary.ttftMs.p50 ?? null;
  } catch {
    result.error = result.checks.loads.status === 'not_run' ? 'load_failed' : 'checks_failed';
    if (result.checks.loads.status === 'not_run')
      result.checks.loads = check(false, 'load_exception');
  } finally {
    await arm.dispose().catch(() => {});
  }
  result.checks.worker = arm.inWorker
    ? executions.length
      ? check(
          executions.every((scope) => scope === 'DedicatedWorkerGlobalScope'),
          'generation_scope_observed',
        )
      : notRun('no_generation_reply')
    : { status: 'not_applicable', reason: 'window_only_api' };
  const observations = result.tasks.flatMap((task) => task.runs.map((run) => run.longTasks));
  if (observations.length && observations.every((item) => item.count !== null)) {
    result.longTasks = {
      count: observations.reduce((total, item) => total + (item.count ?? 0), 0),
      longestMs: Math.max(...observations.map((item) => item.longestMs ?? 0)),
      reason: null,
    };
  }
  return result;
}
export function selectedArms(value: string | null): ArmId[] {
  if (!value || value === 'all') return [...ARM_IDS];
  return [
    ...new Set(
      value.split(',').filter((id): id is ArmId => (ARM_IDS as readonly string[]).includes(id)),
    ),
  ];
}
