// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import { type AgentInstance, createRuntime } from '@galaxie-ai/core';
import { openAICompatible } from '@galaxie-ai/models/openai';
import { createRegistry, Quiz, type Registry } from '@galaxie-ai/react';
import { MemorySaver } from '@langchain/langgraph/web';
import { createTemplateAgent, templateDefinition } from './agent.js';
import type { GatewayState } from './gateway-state.js';
import { createModelFetch } from './model-fetch.js';
import { createSession } from './session.js';

export interface HybridHostOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseURL?: string;
}

export type HybridInstance = AgentInstance<Record<string, never>, unknown>;

export interface HybridHost {
  readonly registry: Registry;
  getGatewayState(): GatewayState;
  subscribeGateway(listener: () => void): () => void;
  /** Call only after the user chooses Start with gateway (or Retry). */
  createInstance(): Promise<HybridInstance>;
  resetSession(): void;
  dispose(): Promise<void>;
}

export function createHybridHost(options: HybridHostOptions = {}): HybridHost {
  const baseURL = options.baseURL ?? location.origin;
  const fetcher = options.fetch ?? globalThis.fetch;
  let state: GatewayState = 'ready';
  const listeners = new Set<() => void>();
  const publish = (next: GatewayState): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const session = createSession(baseURL, fetcher, publish);
  const modelFetch = createModelFetch(fetcher, publish);
  const registry = createRegistry({ components: [Quiz] });
  const runtime = createRuntime({
    appId: 'hybrid-gateway-template',
    executors: [createLangGraphAdapter()],
  });
  return {
    registry,
    getGatewayState: () => state,
    subscribeGateway(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createInstance: () =>
      runtime.create(templateDefinition, {
        principalScope: 'demo-ada',
        agent: createTemplateAgent(),
        services: {
          checkpointer: new MemorySaver(),
          chatModels: {
            gateway: openAICompatible({
              baseURL: new URL('/api/v1', baseURL).href,
              model: 'gateway-comment',
              destination: 'host-server',
              fetch: modelFetch,
            }),
          },
        },
        models: {
          providers: {
            gateway: {
              destination: 'host-server',
              modality: 'text',
              languages: ['en'],
              features: ['streaming', 'cancellation'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
              credential: true,
            },
          },
          roles: { comment: { providers: ['gateway'], allow: ['host-server'], maxTokens: 48 } },
          // Choosing "Start with gateway" is the user's consent for the host-server route.
          consent: () => true,
          getCredential: () => session.token(),
        },
        bindings: {},
        ui: registry.bindings({ surfaces: ['question'] }),
      }),
    resetSession() {
      session.reset();
      publish('ready');
    },
    async dispose() {
      listeners.clear();
      session.reset();
      await runtime.dispose();
    },
  };
}
