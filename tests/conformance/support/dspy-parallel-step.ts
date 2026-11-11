// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryStore,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import fixtures from '../cases-dspy/parallel-fixtures.json' with { type: 'json' };
import { confirmationsFor } from './auto-confirm.js';
import { type ParallelStep, parallelLabels, parallelReply } from './dspy-parallel.js';

export interface ParallelResult {
  readonly sessionId: string;
  readonly calls: string[];
  readonly modelLabels: string[];
  readonly completions: string[];
  readonly streams: unknown[];
  readonly crashed: boolean;
  readonly postTerminationRequests: number;
  readonly restored?: PendingInteraction;
  readonly pending?: PendingInteraction;
  readonly output?: unknown;
  readonly error?: unknown;
}

class ReplyGates {
  readonly rounds = new Map<string, Map<string, ReturnType<typeof Promise.withResolvers<void>>>>();
  readonly order: readonly string[];
  readonly labels: readonly string[];
  constructor(order: readonly string[], labels: readonly string[]) {
    this.labels = labels;
    this.order = [...order, ...labels.filter((label) => !order.includes(label))];
  }
  async wait(round: string, label: string, signal?: AbortSignal): Promise<void> {
    const gates = this.rounds.get(round) ?? new Map();
    this.rounds.set(round, gates);
    const gate = Promise.withResolvers<void>();
    gates.set(label, gate);
    if (gates.size === this.labels.length) gates.get(this.order[0])?.resolve();
    const abort = (): void => gate.reject(new Error('The scripted request was cancelled.'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      await gate.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  delivered(question: string): void {
    const [label, phase] = question.split(':');
    if (!label || !phase) return;
    const index = this.order.indexOf(label);
    const next = this.order[index + 1];
    if (next) this.rounds.get(`model:${phase}`)?.get(next)?.resolve();
  }
}

export async function executeDspyParallelStep(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  step: ParallelStep,
): Promise<ParallelResult> {
  const calls: string[] = [];
  const modelLabels: string[] = [];
  const completions: string[] = [];
  const streams: unknown[] = [];
  const labels = step.name === 'par-fan-eval-loop' ? [...parallelLabels, 'delta'] : parallelLabels;
  const order = fixtures.orders[step.order ?? 'forward'];
  const gates = new ReplyGates(order, labels);
  const crashReady = Promise.withResolvers<void>();
  let restoredDataRegistered = false;
  let succeeded = 0;
  let terminated = false;
  let postTerminationRequests = 0;
  const recovery = new Proxy(store.recovery, {
    get(target, key, receiver) {
      if (key === 'recordEffect')
        return async (...args: Parameters<RecoveryStore['recordEffect']>): Promise<void> => {
          await target.recordEffect(...args);
          if (step.crashAfterTwoWrites && args[2].status === 'succeeded' && ++succeeded === 2)
            crashReady.resolve();
        };
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  class Model extends BaseChatModel {
    override _llmType(): string {
      return 'dspy-parallel-spike';
    }
    override async _generate(
      messages: BaseMessage[],
      options: this['ParsedCallOptions'],
    ): Promise<ChatResult> {
      if (step.sessionId !== undefined && !restoredDataRegistered)
        throw new Error('A live request preceded restored data registration.');
      const text = messages.findLast((message) => message.type === 'human')?.content;
      if (typeof text !== 'string') throw new Error('The scripted question is missing.');
      const question = text.split('[[ ## question ## ]]\n')[1]?.split('\n\n')[0]?.trim();
      if (!question) throw new Error('The scripted question is malformed.');
      modelLabels.push(question);
      const [label, phase] = question.split(':');
      if (!label || !phase) throw new Error('The branch label is missing.');
      if (step.name === 'par-fan-pause-in-branch') {
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) reject(new Error('The scripted request was cancelled.'));
          else
            options.signal?.addEventListener(
              'abort',
              () => reject(new Error('The scripted request was cancelled.')),
              { once: true },
            );
        });
      } else await gates.wait(`model:${phase}`, label, options.signal);
      completions.push(question);
      const reply = parallelReply(question);
      return { generations: [{ text: reply, message: new AIMessage(reply) }] };
    }
  }
  const adapter = createPyodideAdapter({
    ...options,
    framework: 'dspy',
    createWorker() {
      const worker = options.createWorker();
      worker.addEventListener('message', (event) => {
        const value = JSON.parse(String(event.data)) as {
          kind: string;
          op: string;
          payload?: unknown;
        };
        if (
          value.kind === 'notify' &&
          value.op === 'stream' &&
          Array.isArray(value.payload) &&
          (value.payload[2] as { kind?: string } | undefined)?.kind === 'spike-tasks'
        )
          terminated = true;
        else if (
          terminated &&
          value.kind === 'request' &&
          ['model', 'capability'].includes(value.op)
        )
          postTerminationRequests++;
      });
      return {
        ...worker,
        postMessage(message) {
          worker.postMessage(message);
          const value = JSON.parse(message) as {
            kind: string;
            op: string;
            ok?: boolean;
            payload?: { content?: string };
          };
          if (
            value.kind === 'response' &&
            value.op === 'model' &&
            value.ok &&
            value.payload?.content
          ) {
            const question = value.payload.content.split('[[ ## answer ## ]]\n')[1]?.split('\n')[0];
            if (question) gates.delivered(question);
          }
        },
      };
    },
  });
  const runtime = createRuntime({
    appId: 'dspy-parallel-spike',
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
    budgets: { steps: 50, toolCalls: 20, tokens: 5000 },
    outputSafety: () => 'allow',
  });
  let output: unknown;
  let error: unknown;
  let pending: PendingInteraction | undefined;
  let restored: PendingInteraction | undefined;
  let sessionId = step.sessionId ?? '';
  let crashed = false;
  let stopApproving = (): void => {};
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/dspy-parallel',
        version: '1',
        executor: 'dspy-python',
        input: z.object({ question: z.string().meta({ 'x-galaxie': { label: 'private-user' } }) }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'docs.lookup@1': {
              kind: 'write',
              input: z.object({ query: z.string() }),
              output: z.string(),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        recovery,
        confirmations: confirmationsFor(['docs.lookup@1'], 'dspy-parallel-v1'),
        ...(step.sessionId === undefined ? {} : { sessionId: step.sessionId as SessionId }),
        services: { checkpoints: store.checkpoints, chatModels: { mock: new Model({}) } },
        ui: {
          surfaces: ['main'],
          components: { 'test.Review/v1': { actions: { continue: { payload: z.string() } } } },
        },
        bindings: {
          'docs.lookup@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 900000,
            concurrency: 4,
            grantScope: 'instance',
            approval: 'confirm',
            retry: 'none',
            async invoke(input: { query: string }) {
              calls.push(input.query);
              return `receipt:${input.query}`;
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
    sessionId = instance.sessionId;
    await instance.prepare();
    const approved = new Set<string>();
    const approve = (): void => {
      for (const confirmation of instance.getSnapshot().confirmations ?? []) {
        if (approved.has(confirmation.id) || (step.crashAfterTwoWrites && approved.size >= 2))
          continue;
        approved.add(confirmation.id);
        instance.respond(confirmation.id, 'approve');
      }
    };
    stopApproving = instance.subscribe(approve);
    const run =
      step.sessionId === undefined
        ? await instance.start({ question: step.question ?? 'fan-out' })
        : await instance.restore();
    restored = step.sessionId === undefined ? undefined : instance.getSnapshot().run?.pending;
    if (run && restored) {
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        action: 'continue',
        payload: 'continue',
      });
      if (receipt.status !== 'accepted')
        throw new Error('The parallel reload answer was rejected.');
    }
    const collect = (async (): Promise<void> => {
      if (!run) return;
      for await (const event of instance.events(run.runId)) {
        if (event.type === 'output') output = event.output;
        else if (event.type === 'error') error = event.error;
        else if (event.type === 'cancelled') error = toErrorInfo('cancelled');
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
    if (step.crashAfterTwoWrites)
      await Promise.race([
        collect,
        crashReady.promise.then(async () => {
          crashed = true;
          await runtime.dispose();
        }),
      ]);
    await collect;
  } catch (caught) {
    const code = (caught as { code?: Parameters<typeof toErrorInfo>[0] }).code;
    error = toErrorInfo(code ?? 'executor_error');
  } finally {
    stopApproving();
    await runtime.dispose();
  }
  return {
    sessionId,
    calls,
    modelLabels,
    completions,
    streams,
    crashed,
    postTerminationRequests,
    ...(restored === undefined ? {} : { restored }),
    ...(pending === undefined ? {} : { pending }),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
  };
}
