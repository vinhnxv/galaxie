// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import { pythonBuild } from 'virtual:rag-python';
import { replayJavaScriptReview, reviewExpected } from '../review.js';
import { assertTranscript, goldenTranscript, type TranscriptEntry } from '../transcript.js';
import workerUrl from './pyodide-worker.ts?worker&url';
import { executePythonTranscript } from './session.js';

const result: {
  transcript: TranscriptEntry[];
  coldStartMs: number | undefined;
  violations: string[];
  error: string | undefined;
  done: boolean;
} = { transcript: [], coldStartMs: undefined, violations: [], error: undefined, done: false };
Object.assign(globalThis, { pythonParity: result });
addEventListener('securitypolicyviolation', (event) =>
  result.violations.push(event.effectiveDirective),
);
const url = new URL(workerUrl, location.href).href;
const factory = Reflect.get(globalThis, 'trustedTypes') as {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
};
factory.createPolicy('default', {
  createScriptURL(value) {
    if (new URL(value, location.href).href !== url) throw new TypeError('Unexpected Worker URL.');
    return url;
  },
});

void (async () => {
  try {
    const review = new URL(location.href).searchParams.has('review');
    result.transcript = await executePythonTranscript(
      {
        runtimeUrl: new URL('/python/runtime/', location.href).href,
        wheelsUrl: new URL('/python/wheels/', location.href).href,
        localWheels: pythonBuild.localWheels,
        onBoot(event) {
          if (event.phase === 'ready') result.coldStartMs = event.coldStartMs;
        },
        createWorker() {
          const worker = new Worker(url, { type: 'module' });
          worker.addEventListener('message', (event) => {
            const message = JSON.parse(event.data as string) as {
              type?: string;
              directive?: string;
            };
            if (message.type === 'violation')
              result.violations.push(message.directive ?? 'unknown');
          });
          return worker;
        },
      },
      {
        baseUrl: new URL('/python/agent/', location.href).href,
        files: [
          'rag_agent/__init__.py',
          'rag_agent/graph.py',
          'rag_agent/citations.py',
          'rag_agent/prompt.py',
          'rag_agent/prompt.json',
        ],
        module: 'rag_agent.graph',
        entry: 'create_agent',
      },
      review,
    );
    assertTranscript(result.transcript, review ? reviewExpected : goldenTranscript);
    if (review) assertTranscript(await replayJavaScriptReview(), result.transcript);
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Python parity failed.';
  } finally {
    result.done = true;
  }
})();
