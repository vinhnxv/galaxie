// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import { createRuntime, type ModelRouting, type Runtime } from '@galaxie-ai/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

export const canary = 'llmops-synthetic-credential-canary';
export const collectorUrl = 'http://127.0.0.1:4318/v1/traces';

export interface NodeHost {
  runtime: Runtime;
  provider: TracerProvider;
  oracle: InMemorySpanExporter;
  routing: ModelRouting;
  modelFactory(options: { credential: string }): BaseChatModel;
  credentialCalls(): number;
  flush(): Promise<void>;
}

export function createNodeHost(
  model: BaseChatModel,
  options: { key: string; text: boolean; live: boolean },
): NodeHost {
  const oracle = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({ exporter: oracle }),
      ...(options.live
        ? [
            new BatchSpanProcessor({
              exporter: new OTLPTraceExporter({
                url: collectorUrl,
                headers: {},
                timeoutMillis: 5000,
              }),
            }),
          ]
        : []),
    ],
  });
  let calls = 0;
  return {
    provider,
    oracle,
    runtime: createRuntime({
      appId: `llmops-${options.key}`,
      executors: [createLangGraphAdapter()],
      tracerProvider: provider,
      ...(options.text ? { developmentTraceText: { destination: 'host-server' } } : {}),
    }),
    routing: {
      providers: {
        assistant: {
          destination: 'host-server',
          modality: 'text',
          features: ['streaming', 'cancellation'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
          credential: true,
        },
      },
      roles: { assistant: { providers: ['assistant'], allow: ['host-server'], maxTokens: 1000 } },
      consent: () => true,
      getCredential: () => {
        calls++;
        return canary;
      },
    },
    modelFactory: ({ credential }) => {
      if (credential !== canary) throw new Error('Credential did not reach the scripted provider');
      return model;
    },
    credentialCalls: () => calls,
    flush: async () => {
      await provider.forceFlush();
    },
  };
}
