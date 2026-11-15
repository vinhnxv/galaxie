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
import { RunTraceMap, SessionCopy } from './run-trace.js';

export const canary = 'llmops-synthetic-credential-canary';
export const collectorUrl = 'http://127.0.0.1:4318/v1/traces';

export interface HostOptions {
  text: boolean;
  live: boolean;
  exporterUrl?: string;
  flush?: 'complete' | 'none' | 'tolerate';
  autoFlushOnHide?: boolean;
  scheduledDelayMillis?: number;
  sessionCopy?: boolean;
}

export interface Host {
  runtime: Runtime;
  provider: TracerProvider;
  oracle: InMemorySpanExporter;
  runTrace: RunTraceMap;
  routing: ModelRouting;
  modelFactory(options: { credential: string }): BaseChatModel;
  credentialCalls(): number;
  exportErrors: { flush: number; shutdown: number };
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createHost(model: BaseChatModel, options: HostOptions & { key: string }): Host {
  const oracle = new InMemorySpanExporter();
  const runTrace = new RunTraceMap();
  const provider = new TracerProvider({
    spanProcessors: [
      runTrace,
      ...(options.sessionCopy ? [new SessionCopy()] : []),
      new SimpleSpanProcessor({ exporter: oracle }),
      ...(options.live
        ? [
            new BatchSpanProcessor({
              exporter: new OTLPTraceExporter({
                url: options.exporterUrl ?? collectorUrl,
                headers: {},
                timeoutMillis: 5000,
              }),
              ...(options.autoFlushOnHide === undefined
                ? {}
                : { disableAutoFlushOnDocumentHide: !options.autoFlushOnHide }),
              ...(options.scheduledDelayMillis === undefined
                ? {}
                : { scheduledDelayMillis: options.scheduledDelayMillis }),
            }),
          ]
        : []),
    ],
  });
  let calls = 0;
  const exportErrors = { flush: 0, shutdown: 0 };
  const finish = async (operation: 'flush' | 'shutdown'): Promise<void> => {
    if (options.flush === 'none') return;
    try {
      await (operation === 'flush' ? provider.forceFlush() : provider.shutdown());
    } catch (error) {
      if (options.flush !== 'tolerate') throw error;
      exportErrors[operation]++;
    }
  };
  return {
    provider,
    oracle,
    runTrace,
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
    exportErrors,
    flush: () => finish('flush'),
    shutdown: () => finish('shutdown'),
  };
}
