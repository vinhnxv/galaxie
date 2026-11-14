// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { context, trace } from '@opentelemetry/api';
import { StackContextManager, type TracerProvider } from '@opentelemetry/sdk-trace';
import { collectorUrl, type HostOptions } from '../src/host.js';
import { type SpanSnapshot, snapshotSpans } from '../src/oracle.js';
import { runScenario, type ScenarioResult } from '../src/scenarios.js';

export interface PageOptions {
  name: 'linear' | 'interrupt-resume';
  text: boolean;
  exporter: 'proxy' | 'direct';
  flush: NonNullable<HostOptions['flush']>;
  autoFlushOnHide?: boolean;
  scheduledDelayMillis?: number;
}
export interface PageResult extends Omit<ScenarioResult, 'spans'> {
  spans: SpanSnapshot[];
}
export interface Violation {
  directive: string;
  blockedURI: string;
}

declare global {
  interface Window {
    llmops: {
      run(options: PageOptions): Promise<PageResult>;
      flush(): Promise<void>;
      violations: Violation[];
    };
  }
}

const violations: Violation[] = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});
let provider: TracerProvider | undefined;
window.llmops = {
  violations,
  async run({ name, exporter, ...options }) {
    const result = await runScenario(name, {
      ...options,
      live: true,
      exporterUrl:
        exporter === 'proxy' ? new URL('/otel/v1/traces', location.origin).href : collectorUrl,
      onHost(host) {
        provider = host.provider;
        trace.disable();
        trace.setGlobalTracerProvider(provider);
        context.disable();
        context.setGlobalContextManager(new StackContextManager().enable());
      },
    });
    return { ...result, spans: snapshotSpans(result.spans) };
  },
  async flush() {
    if (!provider) throw new Error('No page scenario to flush');
    await provider.forceFlush();
    await provider.shutdown();
  },
};
