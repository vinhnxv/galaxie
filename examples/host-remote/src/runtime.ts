// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  type BindingsFor,
  createRuntime,
  GalaxieError,
  httpCapability,
  type ModelRouting,
  type Runtime,
} from '@galaxie-ai/core';
import {
  createTutorAgent,
  ProgressInputSchema,
  type TutorInput,
  tutorDefinition,
} from '@galaxie-ai/example-english-tutor';
import { BuiltInAIChatModel, checkBuiltInAI } from '@galaxie-ai/models/builtin-ai';
import { openAICompatible } from '@galaxie-ai/models/openai';
import {
  type ConfirmationRegistry,
  createRegistry,
  defineConfirmations,
  educationComponents,
  type Registry,
} from '@galaxie-ai/react';
import { MemorySaver } from '@langchain/langgraph/web';
import { createSession } from './session.js';

export interface RemoteHost {
  readonly runtime: Runtime;
  readonly registry: Registry;
  readonly confirmations: ConfirmationRegistry;
  createInstance(): Promise<AgentInstance<TutorInput, unknown>>;
}

export async function createRemoteHost(
  consent: NonNullable<ModelRouting['consent']>,
): Promise<RemoteHost> {
  const languages = { inputLanguages: ['en'], outputLanguages: ['en'] };
  const feedback =
    import.meta.env.MODE === 'test'
      ? await import('./test-feedback.js').then(({ mockFeedback }) => mockFeedback())
      : await (async () => {
          if ((await checkBuiltInAI(languages)) !== 'available')
            throw new GalaxieError('unavailable', 'Feedback is unavailable.');
          return new BuiltInAIChatModel(languages);
        })();
  const origin = location.origin;
  const token = createSession(origin);
  const headers = async (): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await token()}`,
  });
  const policy = {
    destination: 'host-server',
    timeoutMs: 10_000,
    concurrency: 1,
    grantScope: 'run',
    retry: 'none',
    credentials: 'omit',
    headers,
  } as const;
  const bindings: BindingsFor<typeof tutorDefinition> = {
    'lessons.get@1': httpCapability({
      ...policy,
      method: 'GET',
      kind: 'read',
      approval: 'none',
      url: `${origin}/api/lessons/{lessonId}`,
    }),
    'progress.save@1': httpCapability({
      ...policy,
      method: 'POST',
      kind: 'write',
      approval: 'confirm',
      url: `${origin}/api/progress`,
    }),
  };
  const registry = createRegistry({ components: educationComponents });
  const confirmations = defineConfirmations({
    'progress.save@1': {
      title: 'Save your score?',
      fields: (args) => {
        const { lessonId, score, total } = ProgressInputSchema.parse(args);
        return [
          { label: 'Lesson', value: lessonId },
          { label: 'Score', value: `${score} / ${total}` },
        ];
      },
      approveLabel: 'Save',
      declineLabel: "Don't save",
    },
  });
  const runtime = createRuntime({
    appId: 'galaxie-host-remote',
    executors: [createLangGraphAdapter()],
  });
  return {
    runtime,
    registry,
    confirmations,
    createInstance: () =>
      runtime.create(tutorDefinition, {
        principalScope: 'demo-learner',
        agent: createTutorAgent(),
        services: {
          checkpointer: new MemorySaver(),
          chatModels: {
            quiz: openAICompatible({
              baseURL: new URL('/api/v1', origin).href,
              model: 'host-quiz',
            }),
            feedback,
          },
        },
        models: {
          providers: {
            quiz: {
              destination: 'host-server',
              modality: 'text',
              features: ['streaming', 'cancellation', 'structured-output'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
              credential: true,
            },
            feedback: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming', 'cancellation', 'structured-output'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: {
            'quiz.generate': { providers: ['quiz'], allow: ['host-server'], maxTokens: 2000 },
            'tutor.feedback': { providers: ['feedback'], allow: ['in-browser'], maxTokens: 1000 },
          },
          consent,
          getCredential: token,
        },
        bindings,
        ui: registry.bindings({ surfaces: ['lesson-main'] }),
        confirmations: {
          capabilities: confirmations.capabilities,
          policyRevision: () => 'host-remote-1',
        },
      }),
  };
}
