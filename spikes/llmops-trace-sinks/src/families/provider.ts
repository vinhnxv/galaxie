// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { collectorUrl } from '../host.js';

export interface CoverageProvider {
  provider: TracerProvider;
  oracle: InMemorySpanExporter;
  setExportEnabled(enabled: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** The global provider survives both ADK runs; the content control never leaves memory. */
export function createProvider(
  options: { live?: boolean; global?: boolean } = {},
): CoverageProvider {
  const oracle = new InMemorySpanExporter();
  let enabled = !options.global;
  const exporter = options.live
    ? new OTLPTraceExporter({ url: collectorUrl, headers: {}, timeoutMillis: 5000 })
    : undefined;
  const provider = new TracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({ exporter: oracle }),
      ...(exporter
        ? [
            new BatchSpanProcessor({
              exporter: {
                export: (spans, callback) => {
                  if (enabled) exporter.export(spans, callback);
                  else callback({ code: 0 });
                },
                shutdown: () => exporter.shutdown(),
              },
            }),
          ]
        : []),
    ],
  });
  if (options.global)
    assert.ok(trace.setGlobalTracerProvider(provider), 'Global provider was already registered');
  return {
    provider,
    oracle,
    setExportEnabled(value) {
      enabled = value;
    },
    flush: () => provider.forceFlush(),
    async shutdown() {
      try {
        await provider.shutdown();
      } finally {
        if (options.global) trace.disable();
      }
    },
  };
}
