// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  GalaxieError,
  type ModelRouting,
  type Runtime,
} from '@galaxie-ai/core';
import { buildHostConfig, buildRuntimeLimits } from '@galaxie-ai/core/config';
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
import { validateRemoteHost } from './host-config.js';
import { createSession } from './session.js';

const modelCredentialPlaceholder = 'host-remote-placeholder';

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
  const validated = validateRemoteHost(origin, {
    headers,
    consent,
    getCredential: async () => {
      await token();
      return modelCredentialPlaceholder;
    },
  });
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
    ...buildRuntimeLimits(validated),
    appId: 'galaxie-host-remote',
    executors: [createLangGraphAdapter()],
  });
  return {
    runtime,
    registry,
    confirmations,
    createInstance: async () => {
      const { bindings, modelRouting, endpoints } = buildHostConfig(validated);
      const endpoint = endpoints['quiz'];
      if (endpoint === undefined)
        throw new GalaxieError('invalid', 'The quiz endpoint is missing.');
      return runtime.create(tutorDefinition, {
        principalScope: 'demo-learner',
        agent: createTutorAgent(),
        services: {
          checkpointer: new MemorySaver(),
          chatModels: {
            quiz: openAICompatible({ ...endpoint }),
            feedback,
          },
        },
        models: modelRouting,
        bindings,
        ui: registry.bindings({ surfaces: ['lesson-main'] }),
        confirmations: {
          capabilities: confirmations.capabilities,
          policyRevision: () => 'host-remote-1',
        },
      });
    },
  };
}
