// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryJson,
  type RecoveryStore,
  type SessionId,
} from '@galaxie/core';
import { createMockLatch, type MockScript } from '@galaxie/models/mock';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import specs from '../cases-adk-python/fixtures.json' with { type: 'json' };
import {
  type AdkPythonTranscript,
  AgentScript,
  RecordingModel,
  renumber,
  type Spec,
} from './adk-python.js';

/** Golden cases whose pause survives a reload; each is compared with its one-lifetime golden. */
export const adkPythonReloadCases = [
  'confirm-approve',
  'confirm-deny',
  'confirm-two',
  'long-running',
  'confirm-consecutive',
  'stream-confirm-approve',
  'agents-confirm-last',
] as const;
/** Write cases that need a second lifetime, so they have no golden of their own. */
export const adkPythonWriteCases = ['approved-write', 'resumed-write'] as const;

export interface AdkReloadStep {
  readonly name: string;
  readonly sessionId?: string;
  readonly answerIndex?: number;
  readonly accepted?: boolean;
  readonly crashAfterWrite?: boolean;
  readonly changedWrite?: boolean;
  readonly restoreAfterError?: boolean;
}
export interface AdkReloadResult {
  readonly sessionId: string;
  readonly transcript: AdkPythonTranscript;
  readonly restored?: PendingInteraction;
  readonly pending?: PendingInteraction;
  readonly crashed: boolean;
  readonly consumed: boolean;
  readonly retriedOutput?: unknown;
}
function writeSpec(step: AdkReloadStep): Spec {
  const approved = step.name === 'approved-write';
  return {
    prompt: 'write fixture',
    replies: [
      {
        text: '',
        toolCalls: [
          {
            id: 'approval',
            name: approved ? 'double' : 'confirm',
            args: { value: approved ? 2 : 1 },
          },
        ],
      },
      ...(approved
        ? []
        : [
            {
              text: '',
              toolCalls: [
                { id: 'write', name: 'double', args: { value: step.changedWrite ? 3 : 2 } },
              ],
            },
          ]),
      { text: 'done' },
    ],
    answers: [{ action: 'approve', payload: { indexes: [0] } }],
  };
}

/** One page/Worker lifetime. The caller reopens its store before the next step. */
export async function executeAdkReloadStep(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  step: AdkReloadStep,
): Promise<AdkReloadResult> {
  const write = (adkPythonWriteCases as readonly string[]).includes(step.name);
  const spec = write ? writeSpec(step) : (specs as unknown as Record<string, Spec>)[step.name];
  if (!spec) throw new Error('The reload case is unknown.');
  const transcript: AdkPythonTranscript = {
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
    [spec.prompt]: (spec.replies ?? []).map((reply, index, all) => ({
      ...reply,
      id: `reply-${index}`,
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      ...(step.crashAfterWrite && index === all.length - 1 ? { wait: latch } : {}),
    })),
  };
  const runtime = createRuntime({
    appId: 'adk-python-restore',
    executors: [createPyodideAdapter({ ...options, framework: 'adk' })],
    budgets: { steps: 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (/BLOCKED_(ARGUMENT|TEXT)/.test(text) ? 'block' : 'allow'),
  });
  let pending: PendingInteraction | undefined;
  let restored: PendingInteraction | undefined;
  let crashed = false;
  const schema = {
    input: z.object({ value: z.number().int() }),
    output: z.object({ value: z.number().int() }),
  };
  const binding = (kind: 'read' | 'write', name: string) => ({
    kind,
    destination: 'in-browser' as const,
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'instance' as const,
    approval: 'none' as const,
    retry: 'none' as const,
    async invoke(input: { value: number }) {
      transcript.capabilities.push({ name, input });
      return { value: input.value * 2 };
    },
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/adk-python-restore',
        version: '1.0.0',
        executor: 'adk-python',
        input: z.object({ prompt: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'math.double@1': { kind: write ? 'write' : 'read', ...schema },
            ...(step.name === 'resumed-write'
              ? { 'math.confirm@1': { kind: 'read' as const, ...schema } }
              : {}),
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        recovery: store.recovery,
        ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId as SessionId }),
        services: {
          chatModels: {
            mock: new RecordingModel(
              script,
              transcript,
              [],
              undefined,
              undefined,
              spec.agents ? new AgentScript(spec.agents) : undefined,
            ),
          },
          checkpoints: store.checkpoints,
        },
        ui: {
          surfaces: ['main'],
          components: {
            'tests.Approval/v1': {
              actions: Object.fromEntries(
                ['approve', 'deny', 'submit'].map((action) => [action, { payload: z.unknown() }]),
              ),
            },
          },
        },
        bindings: {
          'math.double@1': binding(write ? 'write' : 'read', 'math.double@1'),
          ...(step.name === 'resumed-write'
            ? { 'math.confirm@1': binding('read', 'math.confirm@1') }
            : {}),
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
    latch.release();
    await runtime.dispose();
  }
}

/** The transcript one uninterrupted lifetime would have recorded. */
export function joinAdkReload(steps: readonly AdkReloadResult[]): AdkPythonTranscript {
  const last = steps.at(-1);
  if (!last) throw new Error('The reload steps are missing.');
  const merged: AdkPythonTranscript = {
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
  const actual = JSON.parse(JSON.stringify(merged)) as AdkPythonTranscript;
  renumber(actual.requests);
  return actual;
}
