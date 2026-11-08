// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryJson,
  type RecoveryStore,
  type SessionId,
} from '@galaxie-ai/core';
import { createMockLatch, type MockScript } from '@galaxie-ai/models/mock';
import type { ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import specs from '../cases-pydantic-ai/fixtures.json' with { type: 'json' };
import { autoApprove, confirmationsFor } from './auto-confirm.js';
import { type PydanticTranscript, RecordingModel } from './pydantic-ai.js';

export const pydanticReloadCases = [
  'approval-approve',
  'approval-deny',
  'approval-mixed',
  'call-deferred',
  'approval-consecutive',
  'stream-approval-approve',
  'approval-invalid-action',
  'approval-incomplete',
] as const;
export interface PydanticReloadStep {
  readonly name: string;
  readonly sessionId?: string;
  readonly answerIndex?: number;
  readonly accepted?: boolean;
  readonly crashAfterWrite?: boolean;
  readonly changedWrite?: boolean;
  readonly restoreAfterError?: boolean;
}
export interface PydanticReloadResult {
  readonly sessionId: string;
  readonly transcript: PydanticTranscript;
  readonly restored?: PendingInteraction;
  readonly pending?: PendingInteraction;
  readonly crashed: boolean;
  readonly consumed: boolean;
  readonly retriedOutput?: unknown;
}

/** One page/Worker lifetime. The caller reopens its store before the next step. */
export async function executePydanticReloadStep(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  step: PydanticReloadStep,
): Promise<PydanticReloadResult> {
  const write = ['approved-write', 'resumed-write'].includes(step.name);
  const spec = write
    ? {
        prompt: 'write fixture',
        replies: [
          {
            text: '',
            toolCalls: [
              {
                id: 'approval',
                name: step.name === 'approved-write' ? 'double' : 'confirm',
                args: step.name === 'approved-write' ? { value: 2 } : {},
              },
            ],
          },
          ...(step.name === 'resumed-write'
            ? [
                {
                  text: '',
                  toolCalls: [
                    { id: 'write', name: 'double', args: { value: step.changedWrite ? 3 : 2 } },
                  ],
                },
              ]
            : []),
          { text: 'done' },
        ],
        answers: [{ action: 'approve', payload: { toolCallIds: ['approval'] } }],
      }
    : (
        specs as Record<
          string,
          {
            prompt: string;
            replies: readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[];
            answers?: readonly { action: string; payload: unknown }[];
          }
        >
      )[step.name];
  if (!spec) throw new Error('The reload case is unknown.');
  const transcript: PydanticTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
    ...(step.name.startsWith('stream-') ? { streams: [] } : {}),
  };
  const latch = createMockLatch();
  const script: MockScript = {
    [spec.prompt]: spec.replies.map((reply, index) => ({
      ...reply,
      id: `reply-${index}`,
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      ...(step.crashAfterWrite && index === spec.replies.length - 1 ? { wait: latch } : {}),
    })),
  };
  const runtime = createRuntime({
    appId: 'pydantic-restore',
    executors: [createPyodideAdapter({ ...options, framework: 'pydantic-ai' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (/BLOCKED_(ARGUMENT|ID|TEXT)/.test(text) ? 'block' : 'allow'),
  });
  let pending: PendingInteraction | undefined;
  let restored: PendingInteraction | undefined;
  let crashed = false;
  let stopApproving = (): void => {};
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/pydantic-restore',
        version: '1',
        executor: 'pydantic-ai-python',
        input: z.unknown(),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'math.double@1': {
              kind: write ? 'write' : 'read',
              input: z.object({ value: z.number().int() }),
              output: z.object({ value: z.number().int() }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        recovery: store.recovery,
        // A model-chosen write runs only behind a host confirmation, approved here as it appears.
        ...(write
          ? { confirmations: confirmationsFor(['math.double@1'], 'pydantic-restore-v1') }
          : {}),
        ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId as SessionId }),
        services: {
          chatModels: { mock: new RecordingModel(script, transcript) },
          checkpoints: store.checkpoints,
        },
        ui: {
          surfaces: ['main'],
          components: {
            'tests.Approval/v1': {
              actions: Object.fromEntries(
                ['approve', 'deny', 'resolve', 'other'].map((action) => [
                  action,
                  { payload: z.unknown() },
                ]),
              ),
            },
          },
        },
        bindings: {
          'math.double@1': {
            kind: write ? 'write' : 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: write ? 'confirm' : 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              transcript.capabilities.push({ name: 'math.double@1', input });
              return { value: input.value * 2 };
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['tool-calling', 'streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    if (write) stopApproving = autoApprove(instance);
    const run =
      step.sessionId === undefined
        ? await instance.start({ prompt: spec.prompt })
        : await instance.restore();
    if (!run) return { sessionId: instance.sessionId, transcript, crashed, consumed: true };
    restored = step.sessionId === undefined ? undefined : instance.getSnapshot().run?.pending;
    if (restored) {
      const answer = spec.answers?.[step.answerIndex ?? 0];
      if (!answer) throw new Error('The reload answer is missing.');
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        ...answer,
      });
      if (receipt.status !== 'accepted') throw new Error('The reload answer was rejected.');
    }
    const collect = (async (): Promise<void> => {
      for await (const event of instance.events(run.runId)) {
        if (event.type === 'output') transcript.output = event.output;
        else if (event.type === 'error') transcript.error = event.error;
        else if (event.type === 'stream')
          transcript.streams?.push({ mode: event.mode, data: event.data });
        else if (
          event.type === 'interaction' &&
          event.interaction.interactionId !== restored?.interactionId
        ) {
          pending = event.interaction;
          transcript.interactions.push({ ...pending, interactionId: 'pause' });
          break;
        }
      }
    })();
    if (step.crashAfterWrite) {
      await Promise.race([
        collect,
        latch.entered.then(async () => {
          crashed = true;
          await runtime.dispose();
        }),
      ]);
    }
    await collect;
    if (pending && step.accepted) {
      const answer = spec.answers?.[step.answerIndex ?? 0];
      if (!answer) throw new Error('The accepted answer is missing.');
      await store.recovery.acceptSubmission(instance.sessionId, {
        interactionId: pending.interactionId,
        action: answer.action,
        payload: answer.payload as RecoveryJson,
      });
    }
    let retriedOutput: unknown;
    if (step.restoreAfterError && transcript.error !== null) {
      const retry = await instance.restore();
      if (retry)
        for await (const event of instance.events(retry.runId)) {
          if (event.type === 'output') retriedOutput = event.output;
          if (event.type === 'error') throw new Error(event.error.message);
          if (event.type === 'interaction') break;
        }
    }
    const submissions = await store.recovery.submissions(instance.sessionId);
    return {
      sessionId: instance.sessionId,
      transcript,
      crashed,
      consumed: submissions.length > 0 && submissions.every((entry) => entry.status === 'consumed'),
      ...(retriedOutput === undefined ? {} : { retriedOutput }),
      ...(restored === undefined ? {} : { restored }),
      ...(pending === undefined ? {} : { pending }),
    };
  } finally {
    stopApproving();
    latch.release();
    await runtime.dispose();
  }
}

export function joinPydanticReload(steps: readonly PydanticReloadResult[]): PydanticTranscript {
  const last = steps.at(-1);
  if (!last) throw new Error('The reload steps are missing.');
  const merged: PydanticTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: last.transcript.output,
    error: last.transcript.error,
    ...(steps[0]?.transcript.streams ? { streams: [] } : {}),
  };
  for (const { transcript } of steps) {
    merged.requests.push(...transcript.requests);
    merged.responses.push(...transcript.responses);
    merged.capabilities.push(...transcript.capabilities);
    merged.interactions.push(...transcript.interactions);
    merged.streams?.push(...(transcript.streams ?? []));
  }
  merged.interactions.splice(
    0,
    merged.interactions.length,
    ...merged.interactions.map((value, index) => ({
      ...(value as object),
      interactionId: `pause-${index}`,
    })),
  );
  return merged;
}
