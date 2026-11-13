// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryStore,
  type SessionId,
} from '@galaxie-ai/core';
import { createMockLatch } from '@galaxie-ai/models/mock';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import { autoApprove, confirmationsFor } from './auto-confirm.js';

export const dspyReloadCases = [
  'durable-module',
  'durable-model-replay',
  'durable-two',
  'durable-large-pauses',
  'durable-frontier-write',
  'durable-private-input',
  'durable-private-result',
  'durable-oversize-completion',
] as const;
export const dspyRejectedRestoreCases = ['durable-url-input', 'durable-url-result'] as const;
export interface DspyReloadStep {
  readonly name: string;
  readonly sessionId?: string;
  readonly start?: boolean;
  readonly accepted?: boolean;
  readonly crashAfterWrite?: boolean;
}
export interface DspyReloadResult {
  readonly sessionId: string;
  readonly calls: string[];
  readonly streams: unknown[];
  readonly requests: number;
  readonly consumed: boolean;
  readonly crashed: boolean;
  readonly restored?: PendingInteraction;
  readonly pending?: PendingInteraction;
  readonly output?: unknown;
  readonly error?: unknown;
}

/** One runtime/Worker lifetime, with a store supplied by the lane. */
export async function executeDspyReloadStep(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  step: DspyReloadStep,
): Promise<DspyReloadResult> {
  const calls: string[] = [];
  const streams: unknown[] = [];
  const latch = createMockLatch();
  let requests = 0;
  let restoredDataRegistered = false;
  class Model extends BaseChatModel {
    override _llmType(): string {
      return 'dspy-reload';
    }
    override async _generate(
      _messages: BaseMessage[],
      options: this['ParsedCallOptions'],
    ): Promise<ChatResult> {
      if (step.sessionId !== undefined && !restoredDataRegistered)
        throw new Error('A live model call preceded restored private data registration.');
      requests++;
      if (step.crashAfterWrite) await latch.wait(options.signal);
      const text = '[[ ## answer ## ]]\ndone\n[[ ## completed ## ]]';
      return { generations: [{ text, message: new AIMessage(text) }] };
    }
  }
  const model = new Model({});
  const adapter = createPyodideAdapter({ ...options, framework: 'dspy' });
  const runtime = createRuntime({
    appId: 'dspy-restore',
    executors: [
      {
        ...adapter,
        async prepare(...args: Parameters<typeof adapter.prepare>) {
          const executor = await adapter.prepare(...args);
          return {
            ...executor,
            run(request: Parameters<typeof executor.run>[0]) {
              return executor.run({
                ...request,
                registerRestoredData(value: unknown): void {
                  if (!request.registerRestoredData)
                    throw new Error('The restored data port is missing.');
                  request.registerRestoredData(value);
                  restoredDataRegistered = true;
                },
              });
            },
          };
        },
      },
    ],
    budgets: { steps: 10, toolCalls: 10, tokens: 1000 },
    urlAllowlist: ['https://allowed.example'],
    outputSafety: () => 'allow',
  });
  let pending: PendingInteraction | undefined;
  let output: unknown;
  let error: unknown;
  let crashed = false;
  let stopApproving = (): void => {};
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-restore',
        version: '1',
        executor: 'dspy-python',
        input: z.object({ question: z.string().meta({ 'x-galaxie': { label: 'private-user' } }) }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'docs.lookup@1': {
              kind: 'write',
              input: z.object({ query: z.string() }),
              output: z.string().meta({ 'x-galaxie': { label: 'private-user' } }),
            },
            'outbound@1': {
              kind: 'read',
              input: z.object({
                query: z.enum(['RESTORED_INPUT_SECRET', 'RESTORED_CAPABILITY_SECRET']),
              }),
              output: z.string(),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        recovery: store.recovery,
        // A model-chosen write runs only behind a host confirmation, approved below as it appears.
        confirmations: confirmationsFor(['docs.lookup@1'], 'dspy-restore-v1'),
        ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId as SessionId }),
        services: {
          checkpoints: store.checkpoints,
          chatModels: {
            mock: model,
          },
        },
        ui: {
          surfaces: ['main'],
          components: { 'test.Review/v1': { actions: { continue: { payload: z.string() } } } },
        },
        bindings: {
          'docs.lookup@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 10000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'confirm',
            retry: 'none',
            async invoke(input: { query: string }) {
              calls.push(input.query);
              return input.query.startsWith('large-')
                ? 'x'.repeat(280000)
                : 'RESTORED_CAPABILITY_SECRET';
            },
          },
          'outbound@1': {
            kind: 'read',
            destination: 'third-party',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke() {
              calls.push('outbound');
              return 'sent';
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: [],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    stopApproving = autoApprove(instance);
    const run =
      step.sessionId === undefined || step.start
        ? await instance.start({ question: 'RESTORED_INPUT_SECRET' })
        : await instance.restore();
    const restored = step.sessionId === undefined ? undefined : instance.getSnapshot().run?.pending;
    if (run && restored) {
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        action: 'continue',
        payload: 'continue',
      });
      if (receipt.status !== 'accepted') throw new Error('The reload answer was rejected.');
    }
    const collect = (async (): Promise<void> => {
      if (!run) return;
      for await (const event of instance.events(run.runId)) {
        if (event.type === 'output') output = event.output;
        else if (event.type === 'error') error = event.error;
        else if (event.type === 'stream') streams.push(event.data);
        else if (
          event.type === 'interaction' &&
          event.interaction.interactionId !== restored?.interactionId
        ) {
          pending = event.interaction;
          break;
        }
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
    if (pending && step.accepted)
      await store.recovery.acceptSubmission(instance.sessionId, {
        interactionId: pending.interactionId,
        action: 'continue',
        payload: 'continue',
      });
    const submissions = await store.recovery.submissions(instance.sessionId);
    return {
      sessionId: instance.sessionId,
      calls,
      streams,
      requests,
      crashed,
      consumed: submissions.length > 0 && submissions.every((item) => item.status === 'consumed'),
      ...(restored === undefined ? {} : { restored }),
      ...(pending === undefined ? {} : { pending }),
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    stopApproving();
    latch.release();
    await runtime.dispose();
  }
}
