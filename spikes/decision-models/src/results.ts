// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Versioned strict-object export and download pattern adapted from
// spikes/b-local-inference/src/results.ts. No prompts, states or returned values are exported.
import { z } from 'zod';
import inventoryData from '../data/inventory.json';
import { ARM_IDS } from './arms/types.js';

const number = z.number().finite().nonnegative();
const count = number.int();
const fraction = z.number().finite().min(0).max(1);
export const reasonSchema = z.enum([
  'not_selected',
  'probe_only',
  'api_missing',
  'api_unavailable',
  'probe_failed',
  'no_webgpu',
  'no_webgpu_adapter',
  'inference_not_implemented',
  'watersheep_browser_packing_unknown',
  'laya_marker_contract_unknown',
  'd1_packing_decoding_not_ported',
  'reference_not_run',
  'reference_candidate_mismatch',
  'inference_failed',
  'load_failed',
  'already_cached',
  'browser_managed',
  'mock_no_download',
  'not_applicable',
  'not_run',
  'not_downloaded',
  'manual_reading_required',
  'unsupported_configuration',
  'not_exposed',
  'input_rejected',
  'invalid_answers',
  'worker_failed',
  'aborted',
  'file_mismatch',
  'download_failed',
  'runtime_metadata_unavailable',
]);
export type Reason = z.infer<typeof reasonSchema>;
const missing = z.strictObject({ status: z.literal('not_measured'), reason: reasonSchema });
export type NotMeasured = z.infer<typeof missing>;
export function notMeasured(reason: Reason): NotMeasured {
  return { status: 'not_measured', reason };
}
function measurement<T extends z.ZodType>(schema: T) {
  return z.union([z.strictObject({ status: z.literal('measured'), value: schema }), missing]);
}
export const availabilitySchema = z.strictObject({
  status: z.enum(['available', 'downloadable', 'unavailable']),
  reason: reasonSchema.nullable(),
  raw: z.string().nullable(),
});
export type Availability = z.infer<typeof availabilitySchema>;
const digestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sha256'), value: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ kind: z.literal('git-blob-sha1'), value: z.string().regex(/^[a-f0-9]{40}$/) }),
]);
export const inventoryFileSchema = z.strictObject({
  path: z.string(),
  bytes: count.nullable(),
  digest: digestSchema.nullable(),
  role: z.string(),
  note: z.string().nullable(),
});
const inventoryEntrySchema = z.strictObject({
  id: z.enum(['d1-2b-onnx', 'watersheep-0.1.0', 'laya-english-q4', 'builtin-ai']),
  name: z.string(),
  source: z.url(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  lastModified: z.iso.datetime().nullable(),
  license: z.strictObject({ weights: z.string().nullable(), code: z.string().nullable() }),
  runtime: z.string(),
  files: z.array(inventoryFileSchema),
  note: z.string(),
  assembly: z
    .strictObject({
      model: z.literal('english'),
      total_bytes: count,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export const inventory = z.array(inventoryEntrySchema).length(4).parse(inventoryData);
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;
export type InventoryFile = z.infer<typeof inventoryFileSchema>;
const verificationSchema = z.strictObject({
  path: z.string(),
  status: z.enum(['not_run', 'verified', 'mismatch', 'unverified_no_digest']),
  actualBytes: count.nullable(),
  computedDigest: z.string().nullable(),
  downloaded: z.boolean().nullable(),
});
export type FileVerification = z.infer<typeof verificationSchema>;
const metadataSchema = z.strictObject({
  name: z.string(),
  type: z.string().nullable(),
  dimensions: z.array(z.union([z.number(), z.string(), z.null()])),
});
const runtimeSchema = z.strictObject({
  inputNames: z.array(z.string()),
  outputNames: z.array(z.string()),
  inputMetadata: z.array(metadataSchema).nullable(),
  outputMetadata: z.array(metadataSchema).nullable(),
});
export type RuntimeDump = z.infer<typeof runtimeSchema>;
export const profileSchema = z.strictObject({
  userAgent: z.string(),
  browserVersion: z.string().nullable(),
  deviceMemoryGiB: number.nullable(),
  hardwareConcurrency: count,
  pageVersion: z.literal('1'),
  ortVersion: z.literal('1.31.0-dev.20260914-8d85527a0'),
  webgpu: z.strictObject({
    present: z.boolean(),
    adapter: z
      .strictObject({
        vendor: z.string(),
        architecture: z.string(),
        device: z.string(),
        description: z.string(),
      })
      .nullable(),
    limits: z.record(z.string(), number),
  }),
});
export type Profile = z.infer<typeof profileSchema>;
export const CHECK_NAMES = [
  'loads',
  'cancels',
  'rejectsOversize',
  'rejectsOverlength',
  'answerTypes',
  'packing0',
  'packing1',
  'packing16',
] as const;
const checkSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'not_run']),
  reason: z.enum([
    'observed',
    'unexpected_behavior',
    'check_exception',
    'not_selected',
    'probe_only',
    'arm_unavailable',
    'inference_not_implemented',
    'load_failed',
    'mock_only',
  ]),
});
export type Check = z.infer<typeof checkSchema>;
const checksSchema = z.strictObject({
  loads: checkSchema,
  cancels: checkSchema,
  rejectsOversize: checkSchema,
  rejectsOverlength: checkSchema,
  answerTypes: checkSchema,
  packing0: checkSchema,
  packing1: checkSchema,
  packing16: checkSchema,
});
const spreadSchema = z.strictObject({
  min: number.nullable(),
  p50: number.nullable(),
  p95: number.nullable(),
  max: number.nullable(),
  p95Reason: z.enum(['no_runs', 'fewer_than_20_runs']).nullable(),
});
const accuracySchema = z.strictObject({
  count: count.positive(),
  correct: count,
  fraction,
  wilson95: z.strictObject({ low: fraction, high: fraction }),
});
const accuracySplit = z.strictObject({
  split: z.enum(['calibration', 'evaluation']),
  overall: accuracySchema,
  byDomain: z.array(
    z.strictObject({
      domain: z.enum(['tutor', 'support', 'write-confirmation', 'privacy']),
      ...accuracySchema.shape,
    }),
  ),
  byType: z.array(
    z.strictObject({ type: z.enum(['boolean', 'choice', 'score']), ...accuracySchema.shape }),
  ),
});
const calibrationSchema = z.union([
  z.strictObject({
    status: z.literal('not_applicable_no_confidence'),
    missingConfidence: count,
    total: count,
  }),
  z.strictObject({
    status: z.literal('measured'),
    value: fraction,
    binCount: z.literal(10),
    minimumPerBin: z.literal(10),
    missingConfidence: count,
    total: count,
    counted: count,
    bins: z
      .array(
        z.strictObject({
          lower: fraction,
          upper: fraction,
          count,
          meanConfidence: fraction.nullable(),
          accuracy: fraction.nullable(),
          belowMinimum: z.boolean(),
        }),
      )
      .length(10),
  }),
]);
const requestTimingSchema = z.strictObject({
  questionCount: count.min(1).max(16),
  tokenizationMs: number,
  endToEndMs: number,
  stateTokens: count.nullable(),
  inputTokens: count.nullable(),
  tokenSource: z.enum(['mock_approximation', 'browser_measureInputUsage', 'unavailable']),
});
const trialSchema = z.strictObject({
  evidence: z.enum(['mock-harness', 'device-demonstration']),
  requests: z.array(requestTimingSchema).min(1).max(2),
  aggregate: z.strictObject({ tokenizationMs: number, endToEndMs: number }),
  repeatedState: z.strictObject({
    processedTimes: count,
    extraPasses: count,
    extraTokens: count.nullable(),
  }),
});
export type Trial = z.infer<typeof trialSchema>;
const latencySchema = z
  .array(
    z.strictObject({
      targetStateTokens: z.union([z.literal(200), z.literal(1000)]),
      questionCount: z.union([z.literal(10), z.literal(30)]),
      packing: z.literal('explicit_caller_requests_max_16'),
      warmup: trialSchema,
      runs: z.array(trialSchema),
      summary: z.strictObject({ tokenizationMs: spreadSchema, endToEndMs: spreadSchema }),
    }),
  )
  .length(4);
const gpuMemorySchema = z.strictObject({
  source: z.literal('manual'),
  unit: z.literal('MiB'),
  modelAlone: number.nullable(),
  withChatModel: number.nullable(),
  status: z.enum(['not_measured', 'measured', 'unsupported_configuration']),
  note: z.literal(
    'Read OS or Chrome task manager; see README manual GPU procedure. Never estimated.',
  ),
});
const baselineSchema = z.strictObject({
  browserVersion: z.string().nullable(),
  availability: availabilitySchema,
  generatedTokenCost: measurement(
    z.strictObject({ total: count, callsWithUsage: count, callsWithoutUsage: count }),
  ),
  schemaFailures: count,
  decisionCalls: count,
  latencyMs: spreadSchema,
  confidence: z.null(),
  alwaysAsk: z.literal(true),
});
export const armResultSchema = z.strictObject({
  id: z.enum(ARM_IDS),
  evidence: z.enum(['mock-harness', 'device-demonstration']),
  profile: profileSchema,
  status: z.enum(['not_run', 'completed', 'unavailable', 'inference_not_implemented', 'failed']),
  reason: reasonSchema.nullable(),
  availability: availabilitySchema,
  inventory: z
    .strictObject({
      id: z.string(),
      revision: z.string().nullable(),
      files: z.array(verificationSchema),
    })
    .nullable(),
  download: measurement(number),
  loadWarm: measurement(number),
  runtime: runtimeSchema.nullable(),
  runtimeReason: reasonSchema.nullable(),
  firstDecision: measurement(latencySchema),
  native30QuestionExperiment: missing,
  gpuMemory: gpuMemorySchema,
  accuracy: measurement(z.array(accuracySplit).length(2)),
  ece: measurement(
    z
      .array(
        z.strictObject({
          split: z.enum(['calibration', 'evaluation']),
          calibration: calibrationSchema,
        }),
      )
      .length(2),
  ),
  agreement: measurement(
    z.strictObject({
      referenceId: z.string(),
      revision: z.string(),
      count: count,
      agreed: count,
      fraction,
    }),
  ),
  builtinAiBaseline: measurement(baselineSchema),
  functionalChecks: checksSchema,
});
export type ArmResult = z.infer<typeof armResultSchema>;
export const resultsSchema = z.strictObject({
  schema: z.literal('galaxie.spike-decision-models.results/v1'),
  createdAt: z.iso.datetime(),
  runs: count.positive(),
  profile: profileSchema,
  inventory: z.array(inventoryEntrySchema).length(4),
  questionSet: z.strictObject({
    id: z.literal('galaxie.spike-decision-models.questions/v1'),
    count: z.literal(200),
    calibrationCount: z.literal(100),
    evaluationCount: z.literal(100),
    eceBins: z.literal(10),
    minimumPerBin: z.literal(10),
    seed: z.literal(20261107),
  }),
  armOrder: z.array(z.enum(ARM_IDS)),
  arms: z.array(armResultSchema).length(5),
});
export type Results = z.infer<typeof resultsSchema>;
export function download(content: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadResults(results: Results): void {
  download(
    `${JSON.stringify(resultsSchema.parse(results), null, 2)}\n`,
    'decision-models-results.json',
    'application/json',
  );
}
