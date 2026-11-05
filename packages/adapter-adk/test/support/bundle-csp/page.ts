// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ProbeResult, runProbe } from '../../bundle-probe.js';
import type { RecordedSpan, SpanRecorder } from './span-recorder.js';

export interface PageData {
  result?: ProbeResult;
  spans?: RecordedSpan[];
  failure?: string;
  done: boolean;
}

const data: PageData = { done: false };
Reflect.set(globalThis, 'adkProbe', data);
const violations = Reflect.get(globalThis, 'adkViolations') as string[];
const recorder = Reflect.get(globalThis, 'adkSpanRecorder') as SpanRecorder | undefined;

runProbe()
  // Violation events are queued as tasks; wait so late ones are included.
  .then((result) => new Promise<ProbeResult>((resolve) => setTimeout(() => resolve(result), 50)))
  .then((result) => {
    data.result = { ...result, violations: [...violations] };
    data.spans = recorder?.spans() ?? [];
  })
  .catch((error: unknown) => {
    data.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    data.spans = recorder?.spans() ?? [];
  })
  .finally(() => {
    data.done = true;
  });
