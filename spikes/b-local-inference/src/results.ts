// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { ARM_IDS } from './arms/types.js';

const nonnegative = z.number().finite().nonnegative();
const armId = z.enum(ARM_IDS);
export const checkSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'not_applicable', 'not_run']),
  reason: z.string(),
  constrained: z.boolean().optional(),
});
export type Check = z.infer<typeof checkSchema>;
export const CHECK_NAMES = [
  'loads',
  'streams',
  'cancels',
  'worker',
  'resetPerSession',
  'schemaEnforcedWhileDecoding',
  'schemaCoverage',
] as const;
const checks = z.strictObject(
  Object.fromEntries(CHECK_NAMES.map((name) => [name, checkSchema])) as Record<
    (typeof CHECK_NAMES)[number],
    typeof checkSchema
  >,
);
const spread = z.strictObject({
  min: nonnegative.nullable(),
  p50: nonnegative.nullable(),
  p95: nonnegative.nullable(),
  max: nonnegative.nullable(),
  p95Reason: z.enum(['fewer_than_20_runs', 'no_runs']).nullable(),
});
const longTasks = z.strictObject({
  count: nonnegative.nullable(),
  longestMs: nonnegative.nullable(),
  reason: z.string().nullable(),
});
const run = z.strictObject({
  ttftMs: nonnegative.nullable(),
  totalMs: nonnegative,
  length: nonnegative,
  lengthUnit: z.enum(['tokens', 'characters']),
  valid: z.boolean().nullable(),
  constrained: z.boolean(),
  forcedTokens: nonnegative.nullable(),
  modelChosenTokens: nonnegative.nullable(),
  tokensPerSecond: nonnegative.nullable(),
  longTasks,
});
const task = z.strictObject({
  id: z.enum(['quiz', 'feedback-en', 'feedback-vi']),
  status: z.enum(['completed', 'not_run']),
  reason: z.string().nullable(),
  warmupMs: nonnegative.nullable(),
  runs: z.array(run),
  summary: z.strictObject({
    totalMs: spread,
    ttftMs: spread,
    length: spread,
    tokensPerSecond: spread,
    validRuns: nonnegative.nullable(),
    distinctOutputs: nonnegative,
  }),
});
const load = z.strictObject({
  loadKind: z.enum(['cold', 'warm', 'unknown']),
  elapsedMs: nonnegative,
  reason: z.string().nullable(),
  reportedBytes: nonnegative.nullable(),
});
export const armResultSchema = z.strictObject({
  id: armId,
  model: z.strictObject({ id: z.string(), revision: z.string().nullable() }),
  engineVersion: z.string(),
  inWorker: z.boolean(),
  decoding: z.enum(['greedy', 'browser-default']),
  schemaMechanism: z.string(),
  sameCheckpointAs: armId.nullable(),
  availability: z.strictObject({
    status: z.enum(['available', 'downloadable', 'unavailable']),
    reason: z
      .enum([
        'no_webgpu_adapter',
        'no_shader_f16',
        'api_missing',
        'language_unsupported',
        'not_implemented',
      ])
      .optional(),
    raw: z.string().nullable().optional(),
  }),
  checks,
  loads: z.array(load),
  coldLoadMs: nonnegative.nullable(),
  coldLoadReason: z.string().nullable(),
  warmLoadMs: nonnegative.nullable(),
  download: z.strictObject({
    storageDeltaBytes: z.number().finite().nullable(),
    reportedBytes: nonnegative.nullable(),
    reason: z.string().nullable(),
  }),
  cancel: z
    .strictObject({
      chunksAtAbort: nonnegative,
      abortToSettleMs: nonnegative.nullable(),
      chunksAfterSettle: nonnegative,
      nextRequestSucceeded: z.boolean(),
      nextRequestTtftMs: nonnegative.nullable(),
      medianFeedbackTtftMs: nonnegative.nullable(),
    })
    .nullable(),
  tasks: z.array(task),
  longTasks,
  error: z.enum(['load_failed', 'checks_failed', 'task_failed']).nullable(),
});
export type ArmResult = z.infer<typeof armResultSchema>;
export const chatWebLLMSchema = z.strictObject({
  status: z.enum(['completed', 'not_run', 'failed']),
  reason: z.string().nullable(),
  engineInjection: z.literal('protected-field-overwrite'),
  constructionStartedInThread: z.boolean().nullable(),
  invoke: checkSchema,
  stream: checkSchema,
  temperatureReachedEngine: z.boolean().nullable(),
  schemaReachedEngine: z.boolean().nullable(),
  abortSignalReachedEngine: z.boolean().nullable(),
  schemaAccepted: z.boolean().nullable(),
  resetPerSession: checkSchema,
});
export const resultsSchema = z.strictObject({
  schema: z.literal('galaxie.spike-b.results/v1'),
  createdAt: z.iso.datetime(),
  page: z.strictObject({ commit: z.string().optional(), origin: z.string() }),
  device: z.strictObject({
    userAgent: z.string(),
    chromeVersion: z.string().nullable(),
    logicalCores: nonnegative,
    webgpu: z.strictObject({
      adapter: z
        .strictObject({
          vendor: z.string(),
          architecture: z.string(),
          description: z.string(),
          shaderF16: z.boolean(),
        })
        .nullable(),
    }),
  }),
  armOrder: z.array(armId),
  runs: z.number().int().positive(),
  arms: z.array(armResultSchema),
  chatWebLLM: chatWebLLMSchema,
  promptApiAvailability: z.strictObject({
    en: z.string(),
    vi: z.string(),
    reason: z.string().nullable(),
  }),
});
export type ResultsV1 = z.infer<typeof resultsSchema>;
export function notRun(reason: string): Check {
  return { status: 'not_run', reason };
}
export function emptyChatCheck(reason: string): ResultsV1['chatWebLLM'] {
  return {
    status: 'not_run',
    reason,
    engineInjection: 'protected-field-overwrite',
    constructionStartedInThread: null,
    invoke: notRun(reason),
    stream: notRun(reason),
    temperatureReachedEngine: null,
    schemaReachedEngine: null,
    abortSignalReachedEngine: null,
    schemaAccepted: null,
    resetPerSession: notRun(reason),
  };
}
export function downloadResults(results: ResultsV1): void {
  const json = JSON.stringify(resultsSchema.parse(results), null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `spike-b-results-${results.createdAt.slice(0, 10)}-${results.armOrder.join('_')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
