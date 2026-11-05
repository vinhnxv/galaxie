// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../src/host/adk-env.js';

import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '@galaxie/adapter-pyodide';
import {
  type AgentInstance,
  type CapabilityBinding,
  createRuntime,
  GalaxieError,
  type PendingInteraction,
  type RecoveryStore,
  type RunEvent,
  type RunId,
  type SessionId,
} from '@galaxie/core';
import type { MockLatch } from '@galaxie/models/mock';
import { createHostCapabilities } from '../../src/host/capabilities.js';
import { auditorDefinition } from '../../src/recipes/llm-auditor/definition.js';
import {
  AUDITOR_EMPTY_PROMPT,
  AUDITOR_SAMPLE_PROMPT,
  createAuditorMockModels,
} from '../../src/recipes/llm-auditor/script.js';
import { loanDefinition } from '../../src/recipes/loan/definition.js';
import {
  type LoanOutcome,
  loanApprovalProps,
  loanInteractionBindings,
  loanOutcome,
} from '../../src/recipes/loan/interaction.js';
import { createLoanMockModels, LOAN_SAMPLE_PROMPT } from '../../src/recipes/loan/script.js';

export interface RecipeObservation {
  readonly status: string | undefined;
  readonly output: unknown;
  readonly error: { readonly code: string; readonly message: string } | undefined;
  readonly pending: PendingInteraction | undefined;
  readonly events: readonly RunEvent[];
}

export async function observe(
  instance: AgentInstance<unknown, unknown>,
  runId: RunId,
  seen?: string,
): Promise<RecipeObservation> {
  const events: RunEvent[] = [];
  let output: unknown;
  let error: RecipeObservation['error'];
  let pending: PendingInteraction | undefined;
  for await (const event of instance.events(runId)) {
    events.push(event);
    if (event.type === 'output') output = event.output;
    if (event.type === 'error') error = event.error;
    if (event.type === 'interaction' && event.interaction.interactionId !== seen) {
      pending = event.interaction;
      break;
    }
  }
  return { status: instance.getSnapshot().run?.status, output, error, pending, events };
}

export async function runAuditor(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  scenario: 'normal' | 'empty' | 'denied' = 'normal',
  wait?: MockLatch,
): Promise<RecipeObservation & { readonly searches: readonly unknown[] }> {
  const mock = createAuditorMockModels(scenario, wait);
  const capabilities = createHostCapabilities('demo');
  const search = capabilities.bindings['market.search@1'];
  const searches: unknown[] = [];
  const runtime = createRuntime({
    appId: 'adk-recipes-auditor',
    executors: [createPyodideAdapter({ ...options, framework: 'adk' })],
    budgets: { steps: 10, toolCalls: 2, tokens: 20000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(auditorDefinition, {
      principalScope: 'demo',
      agent,
      services: { chatModels: mock.chatModels },
      models: mock.routing,
      bindings: {
        'market.search@1': {
          ...search,
          invoke: async (input, context) => {
            searches.push(input);
            if (scenario === 'denied') {
              throw new GalaxieError('denied', 'Host detail must not reach the model.');
            }
            return search.invoke(input, context);
          },
        },
      },
    });
    await instance.prepare();
    const run = await instance.start({
      prompt: scenario === 'empty' ? AUDITOR_EMPTY_PROMPT : AUDITOR_SAMPLE_PROMPT,
    });
    const observed = observe(instance, run.runId);
    if (wait) {
      await wait.entered;
      await instance.cancel(run.runId);
    }
    return { ...(await observed), searches };
  } finally {
    wait?.release();
    await runtime.dispose();
  }
}

export interface LoanStore {
  readonly checkpoints: { request(value: unknown): Promise<unknown> };
  readonly recovery: RecoveryStore;
}
export interface LoanHost {
  readonly runtime: ReturnType<typeof createRuntime>;
  readonly instance: AgentInstance<unknown, unknown>;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly calls: string[];
  outcome(pending?: PendingInteraction): LoanOutcome;
}

export async function openLoan(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: LoanStore,
  input: {
    readonly sessionId?: string;
    readonly scenario?: 'approve' | 'deny' | 'text-only';
    readonly afterWrite?: MockLatch;
    readonly capabilities?: ReturnType<typeof createHostCapabilities>;
  } = {},
): Promise<LoanHost> {
  const mock = createLoanMockModels(input.scenario, input.afterWrite);
  const capabilities = input.capabilities ?? createHostCapabilities('demo');
  const calls: string[] = [];
  const bindings: Record<string, CapabilityBinding<never, unknown>> = {};
  for (const name of [
    'loan.documents@1',
    'loan.business@1',
    'loan.price@1',
    'loan.finalize@1',
  ] as const) {
    const binding = capabilities.bindings[name];
    Object.assign(bindings, {
      [name]: {
        ...binding,
        invoke: async (args: never, context: Parameters<typeof binding.invoke>[1]) => {
          calls.push(name);
          return binding.invoke(args, context);
        },
      },
    });
  }
  const runtime = createRuntime({
    appId: 'adk-recipes-loan',
    executors: [createPyodideAdapter({ ...options, framework: 'adk' })],
    budgets: { steps: 15, toolCalls: 6, tokens: 30000 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(loanDefinition, {
      principalScope: 'demo',
      agent,
      recovery: store.recovery,
      ...(input.sessionId ? { sessionId: input.sessionId as SessionId } : {}),
      services: { chatModels: mock.chatModels, checkpoints: store.checkpoints },
      models: mock.routing,
      bindings,
      ui: loanInteractionBindings,
      confirmations: { capabilities: ['loan.finalize@1'], policyRevision: () => 'loan-1' },
    });
    await instance.prepare();
    return {
      runtime,
      instance,
      capabilities,
      calls,
      outcome: (pending) =>
        loanOutcome('application-lantern', pending?.props, capabilities.decisions()),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function startLoan(
  host: LoanHost,
  restore = false,
): Promise<{ runId: RunId; observation: RecipeObservation }> {
  const run = restore
    ? await host.instance.restore()
    : await host.instance.start({ prompt: LOAN_SAMPLE_PROMPT });
  if (!run) throw new Error('The loan run is missing.');
  return { runId: run.runId, observation: await observe(host.instance, run.runId) };
}

/** Simulates one explicit human action, including the independent broker gate for that exact write. */
export async function answerLoan(
  host: LoanHost,
  runId: RunId,
  pending: PendingInteraction,
  action: 'approve' | 'deny',
): Promise<RecipeObservation> {
  const proposed = loanApprovalProps.parse(pending.props);
  const responded = new Set<string>();
  const unsubscribe = host.instance.subscribe(() => {
    for (const confirmation of host.instance.getSnapshot().confirmations ?? []) {
      if (responded.has(confirmation.id)) continue;
      responded.add(confirmation.id);
      const args = loanApprovalProps.safeParse(confirmation.arguments);
      const matches =
        action === 'approve' &&
        confirmation.capability === 'loan.finalize@1' &&
        args.success &&
        args.data.applicationId === proposed.applicationId &&
        args.data.decision === proposed.decision;
      host.instance.respond(confirmation.id, matches ? 'approve' : 'decline');
    }
  });
  try {
    const receipt = await host.instance.dispatch({
      instanceId: host.instance.instanceId,
      runId,
      ...pending,
      action,
      payload: { indexes: [0] },
    });
    if (receipt.status !== 'accepted') throw new Error('The loan answer was rejected.');
    return await observe(host.instance, runId, pending.interactionId);
  } finally {
    unsubscribe();
  }
}
