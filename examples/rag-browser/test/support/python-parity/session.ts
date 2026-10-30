// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '@galaxie/adapter-pyodide';
import { createRuntime } from '@galaxie/core';
import { pythonRagDefinition } from '../../../src/agent/definition-python.js';
import type { RagOutput } from '../../../src/agent/schemas.js';
import { reviewRegistry } from '../../../src/host/review-passages.js';
import { recordReview, reviewScript } from '../review.js';
import { createTranscriptReplay, parityScript, type TranscriptEntry } from '../transcript.js';

export async function executePythonTranscript(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  review = false,
): Promise<TranscriptEntry[]> {
  const transcript: TranscriptEntry[] = [];
  const replay = createTranscriptReplay(review ? reviewScript : parityScript, transcript);
  const runtime = createRuntime({
    appId: 'rag-python-parity',
    executors: [createPyodideAdapter(options)],
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(pythonRagDefinition, {
      principalScope: 'fixture',
      ui: reviewRegistry.bindings({ surfaces: ['rag-review'] }),
      agent,
      services: { chatModels: { mock: replay.model } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            features: ['streaming'],
            languages: ['en'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 500 } },
      },
      bindings: {
        'docs.search@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          invoke: replay.search,
        },
      },
    });
    await instance.prepare();
    if (review) {
      const stream = await recordReview(instance, transcript);
      if (!stream.subgraph || stream.text !== 'Paris is the capital [1]. [9]')
        throw new Error('The review stream differs.');
      return transcript;
    }
    for (const item of parityScript.session) {
      const { runId } = await instance.start(item.input);
      for await (const event of instance.events(runId)) {
        if (event.type === 'output')
          transcript.push({ type: 'output', output: event.output as RagOutput });
        else if (event.type === 'error') throw new Error(event.error.message);
      }
    }
    return transcript;
  } finally {
    await runtime.dispose();
  }
}
