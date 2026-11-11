// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type RecoveryStore,
  type SessionId,
} from '@galaxie-ai/core';
import type { MockScript } from '@galaxie-ai/models/mock';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import specs from '../cases-pydantic-ai-delegation-suite/fixtures.json' with { type: 'json' };
import { autoApprove, confirmationsFor } from './auto-confirm.js';
import { type PydanticTranscript, RecordingModel } from './pydantic-ai.js';

export const delegationCases = [
  'delegation-reload-write',
  'delegation-shared-budgets',
  'delegation-nested-plain-refused',
] as const;
export type DelegationCase = (typeof delegationCases)[number];

/** The reload case runs each side of its parent approval in a fresh Worker. */
export async function executeDelegationCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  name: DelegationCase,
): Promise<PydanticTranscript> {
  const first = await runDelegationLifetime(options, agent, store, name);
  const transcripts = [first.transcript];
  if (first.pending) {
    const second = await runDelegationLifetime(options, agent, store, name, first.sessionId);
    transcripts.push(second.transcript);
    if (JSON.stringify(second.restored) !== JSON.stringify(first.pending) || second.pending) {
      throw new Error('The restored delegation approval changed.');
    }
  }
  return joinDelegationTranscripts(transcripts);
}

export async function runDelegationLifetime(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  store: {
    readonly checkpoints: { request(value: unknown): Promise<unknown> };
    readonly recovery: RecoveryStore;
  },
  name: DelegationCase,
  sessionId?: string,
): Promise<DelegationLifetime> {
  const spec = specs[name];
  const script: MockScript = Object.fromEntries(
    Object.entries(spec.scripts).map(([prompt, replies]) => [
      prompt,
      replies.map((reply, index) => ({
        ...reply,
        id: `${prompt}-${index}`,
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      })),
    ]),
  );

  const transcript: PydanticTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
  const adapter = createPyodideAdapter({ ...options, framework: 'pydantic-ai' });
  const streams = { events: 0, nonEmptyPaths: 0 };
  const runtime = createRuntime({
    appId: 'delegation-conformance',
    executors: [adapter],
    budgets: { steps: spec.steps, toolCalls: 10, tokens: 2000 },
  });
  let stopApproving = (): void => {};
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/pydantic-delegation',
        version: '1',
        executor: 'pydantic-ai-python',
        input: z.unknown(),
        models: {
          parent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
          child: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
        },
        capabilities: {
          required: {
            'math.double@1': {
              kind: 'write',
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
        confirmations: confirmationsFor(['math.double@1'], 'delegation-conformance-v1'),
        ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
        services: {
          chatModels: {
            mock: new RecordingModel(
              script,
              transcript,
              [],
              undefined,
              undefined,
              'assistant-turns',
            ),
          },
          checkpoints: store.checkpoints,
        },
        ui: {
          surfaces: ['main'],
          components: {
            'tests.Approval/v1': { actions: { approve: { payload: z.unknown() } } },
          },
        },
        bindings: {
          'math.double@1': {
            kind: 'write',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'confirm',
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
          roles: {
            parent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 },
            child: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 },
          },
        },
      },
    );
    await instance.prepare();
    stopApproving = autoApprove(instance);
    const run =
      sessionId === undefined
        ? await instance.start({ prompt: spec.prompt })
        : await instance.restore();
    if (!run) throw new Error('The delegation run is missing.');
    const restored = sessionId === undefined ? undefined : instance.getSnapshot().run?.pending;
    if (restored) {
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        action: 'approve',
        payload: { toolCallIds: ['gate'] },
      });
      if (receipt.status !== 'accepted') throw new Error('The delegation answer was rejected.');
    }
    let pending: PendingInteraction | undefined;
    for await (const event of instance.events(run.runId)) {
      if (event.type === 'stream') {
        streams.events++;
        if (event.path.length > 0) streams.nonEmptyPaths++;
      } else if (event.type === 'output') transcript.output = event.output;
      else if (event.type === 'error') transcript.error = event.error;
      else if (
        event.type === 'interaction' &&
        event.interaction.interactionId !== restored?.interactionId
      ) {
        pending = event.interaction;
        transcript.interactions.push(pending);
        break;
      }
    }
    return {
      sessionId: instance.sessionId,
      transcript,
      writes: transcript.capabilities.length,
      streams,
      subgraphs: adapter.features.subgraphs,
      ...(pending === undefined ? {} : { pending }),
      ...(restored === undefined ? {} : { restored }),
    };
  } finally {
    stopApproving();
    await runtime.dispose();
  }
}

export interface DelegationLifetime {
  readonly sessionId: string;
  readonly transcript: PydanticTranscript;
  readonly pending?: PendingInteraction;
  readonly restored?: PendingInteraction;
  readonly writes: number;
  readonly streams: { readonly events: number; readonly nonEmptyPaths: number };
  readonly subgraphs: boolean;
}

export function joinDelegationTranscripts(
  transcripts: readonly PydanticTranscript[],
): PydanticTranscript {
  const last = transcripts.at(-1);
  if (!last) throw new Error('The delegation transcript is missing.');
  return {
    requests: transcripts.flatMap((value) => value.requests),
    responses: transcripts.flatMap((value) => value.responses),
    capabilities: transcripts.flatMap((value) => value.capabilities),
    interactions: transcripts
      .flatMap((value) => value.interactions)
      .map((value, index) => ({
        ...(value as object),
        interactionId: `pause-${index}`,
      })),
    output: last.output,
    error: last.error,
  };
}
