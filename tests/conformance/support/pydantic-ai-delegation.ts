// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentSnapshot,
  type BudgetLimits,
  createRuntime,
  defineAgentDefinition,
  galaxieField,
  type PendingInteraction,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { createMockLatch, type MockScript } from '@galaxie-ai/models/mock';
import type { ToolCall } from '@langchain/core/messages';
import type { Attributes } from '@opentelemetry/api';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { createSpanRecorder } from '../../../packages/core/test/span-tree.js';
import { MemoryRecoveryStore } from '../../../packages/core/test/support/memory-recovery-store.js';
import specs from '../cases-pydantic-ai-delegation/fixtures.json' with { type: 'json' };
import { autoApprove, confirmationsFor } from './auto-confirm.js';
import { MemoryByteCheckpoints } from './memory-byte-checkpoints.js';
import { type PydanticTranscript, RecordingModel } from './pydantic-ai.js';

interface Spec {
  readonly prompt: string;
  readonly scripts: Record<
    string,
    readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[]
  >;
}

export function delegationStore(): {
  checkpoints: MemoryByteCheckpoints;
  recovery: MemoryRecoveryStore;
  effects: string[];
} {
  const recovery = new MemoryRecoveryStore();
  const effects: string[] = [];
  const effect = recovery.effect.bind(recovery);
  recovery.effect = async (sessionId, effectId) => {
    effects.push(effectId);
    return effect(sessionId, effectId);
  };
  return { checkpoints: new MemoryByteCheckpoints(), recovery, effects };
}

export interface DelegationStep {
  readonly name: string;
  readonly budgets?: Partial<BudgetLimits>;
  readonly privateOutput?: boolean;
  readonly remoteChild?: boolean;
  readonly blockChild?: boolean;
  readonly store?: ReturnType<typeof delegationStore>;
  readonly sessionId?: string;
  readonly answer?: boolean;
  readonly crashAfterWrite?: boolean;
  readonly repairAttempts?: number;
  readonly delegateId?: string;
}

export interface DelegationResult {
  readonly sessionId: string;
  readonly transcript: PydanticTranscript;
  readonly events: RunEvent[];
  readonly checks: string[];
  readonly writes: { value: number; effectId: string | undefined }[];
  readonly pending: PendingInteraction | undefined;
  readonly restored: PendingInteraction | undefined;
  readonly snapshot: AgentSnapshot<unknown>;
  readonly crashed: boolean;
  readonly spans: { name: string; attributes: Attributes }[];
  readonly subgraphs: boolean;
}

/** One runtime lifetime: reload shares stores, never Python tool stack frames. */
export async function executeDelegationProbe(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  step: DelegationStep,
): Promise<DelegationResult> {
  const spec = (specs as Record<string, Spec>)[step.name];
  if (!spec) throw new Error('Unknown delegation script.');
  const write = ['recovery', 'hoist', 'flatten'].includes(step.name);
  const transcript: PydanticTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
  const latch = createMockLatch();
  const delegateId = step.delegateId;
  const script: MockScript = Object.fromEntries(
    Object.entries(spec.scripts).map(([prompt, replies]) => [
      prompt,
      replies.map((reply, index) => ({
        ...reply,
        ...(prompt === 'parent' && delegateId !== undefined && reply.toolCalls
          ? {
              toolCalls: reply.toolCalls.map((call) =>
                call.name === 'delegate' ? { ...call, id: delegateId } : call,
              ),
            }
          : {}),
        id: `${prompt}-${index}`,
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        ...(step.crashAfterWrite && prompt === 'child' && index === replies.length - 1
          ? { wait: latch }
          : {}),
      })),
    ]),
  );
  const model = new RecordingModel(script, transcript, [], undefined, undefined, 'assistant-turns');
  const checks: string[] = [];
  const events: RunEvent[] = [];
  const writes: { value: number; effectId: string | undefined }[] = [];
  const { provider, exporter } = createSpanRecorder();
  const adapter = createPyodideAdapter({ ...options, framework: 'pydantic-ai' });
  const runtime = createRuntime({
    appId: 'delegation-probes',
    executors: [adapter],
    budgets: { steps: 25, toolCalls: 10, tokens: 1000, cost: 1000, ...step.budgets },
    ...(step.remoteChild ? { dataPolicy: { app: { allow: ['in-browser', 'third-party'] } } } : {}),
    tracerProvider: provider,
    outputSafety: ({ text }) => {
      checks.push(text);
      return step.blockChild && text.includes('child-') ? 'block' : 'allow';
    },
  });
  let stopApproving = (): void => {};
  let pending: PendingInteraction | undefined;
  let restored: PendingInteraction | undefined;
  let crashed = false;
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/delegation',
        version: '1',
        executor: 'pydantic-ai-python',
        input: z.unknown(),
        models: {
          answer: { modality: 'text', languages: ['en'] },
          child: { modality: 'text', languages: ['en'] },
        },
        capabilities: {
          required: {
            'math.double@1': {
              kind: write ? 'write' : 'read',
              input: z.object({ value: z.number().int() }),
              output: z.object({
                value: z
                  .number()
                  .int()
                  .meta(galaxieField({ label: step.privateOutput ? 'private-user' : 'public' })),
              }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        ...(step.store === undefined
          ? {}
          : {
              recovery: step.store.recovery,
              ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId as SessionId }),
            }),
        ...(write ? { confirmations: confirmationsFor(['math.double@1'], 'delegation-v1') } : {}),
        services: {
          chatModels: { local: model, remote: model },
          ...(step.store === undefined ? {} : { checkpoints: step.store.checkpoints }),
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
            async invoke(input: { value: number }, context) {
              transcript.capabilities.push({ name: 'math.double@1', input });
              writes.push({ value: input.value, effectId: context.effectId });
              return { value: input.value * 2 };
            },
          },
        },
        ui: {
          surfaces: ['main'],
          components: {
            'tests.Approval/v1': {
              actions: { approve: { payload: z.unknown() }, deny: { payload: z.unknown() } },
            },
          },
        },
        models: {
          providers: {
            local: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['tool-calling', 'streaming', 'structured-output'],
              pricing: { inputPerToken: 1, outputPerToken: 1 },
            },
            remote: {
              destination: 'third-party',
              modality: 'text',
              languages: ['en'],
              features: ['tool-calling', 'streaming', 'structured-output'],
              pricing: { inputPerToken: 1, outputPerToken: 1 },
            },
          },
          roles: {
            answer: { providers: ['local'], allow: ['in-browser'], maxTokens: 4 },
            child: {
              providers: [step.remoteChild ? 'remote' : 'local'],
              allow: [step.remoteChild ? 'third-party' : 'in-browser'],
              maxTokens: 4,
              repairAttempts: step.repairAttempts ?? 0,
            },
          },
          consent: () => true,
        },
      },
    );
    await instance.prepare();
    if (write) stopApproving = autoApprove(instance);
    const run =
      step.sessionId === undefined
        ? await instance.start({ prompt: spec.prompt })
        : await instance.restore();
    if (!run) throw new Error('Expected a run to restore.');
    if (step.sessionId !== undefined) restored = instance.getSnapshot().run?.pending;
    const answerPending = async (interaction: PendingInteraction): Promise<void> => {
      const props = interaction.props as { calls: { id: string }[] };
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...interaction,
        action: 'approve',
        payload: { toolCallIds: props.calls.map((call) => call.id) },
      });
      if (receipt.status !== 'accepted') throw new Error('Probe answer was rejected.');
    };
    if (restored && step.answer) await answerPending(restored);
    const collect = (async (): Promise<void> => {
      for await (const event of instance.events(run.runId)) {
        events.push(event);
        if (event.type === 'output') transcript.output = event.output;
        if (event.type === 'error') transcript.error = event.error;
        if (event.type !== 'interaction') continue;
        pending = event.interaction;
        transcript.interactions.push(pending);
        if (pending.interactionId === restored?.interactionId) continue;
        if (!step.answer) break;
        await answerPending(pending);
      }
    })();
    if (step.crashAfterWrite)
      await Promise.race([
        collect,
        latch.entered.then(async () => {
          crashed = true;
          await runtime.dispose();
        }),
      ]);
    await collect;
    const snapshot = instance.getSnapshot();
    await runtime.dispose();
    await provider.forceFlush();
    return {
      sessionId: instance.sessionId,
      transcript,
      events,
      checks,
      writes,
      pending,
      restored,
      snapshot,
      crashed,
      spans: exporter
        .getFinishedSpans()
        .map((span) => ({ name: span.name, attributes: span.attributes })),
      subgraphs: adapter.features.subgraphs,
    };
  } finally {
    stopApproving();
    latch.release();
    await runtime.dispose();
    await provider.shutdown();
  }
}
