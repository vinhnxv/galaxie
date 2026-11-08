// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import { createPyodideAdapter } from '@galaxie-ai/adapter-pyodide';
import { createRuntime } from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { ragDefinition } from '../src/agent/definition.js';
import { pythonRagDefinition } from '../src/agent/definition-python.js';
import { createRagAgent } from '../src/agent/graph.js';
import { reviewRegistry } from '../src/host/review-passages.js';
import { createPythonFixture, pythonWheelsAvailable } from './support/python.node.js';
import { recordReview, reviewReplay, reviewRouting } from './support/review.js';
import type { TranscriptEntry } from './support/transcript.js';

async function reviewOnNode(executor: 'javascript' | 'python'): Promise<void> {
  const fixture = executor === 'python' ? await createPythonFixture() : undefined;
  const transcript: TranscriptEntry[] = [];
  const replay = reviewReplay(transcript);
  const runtime = createRuntime({
    appId: 'rag-review-parity',
    executors: [
      createLangGraphAdapter(),
      ...(fixture ? [createPyodideAdapter(fixture.options)] : []),
    ],
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(
      executor === 'python' ? pythonRagDefinition : ragDefinition,
      {
        principalScope: 'fixture',
        agent: fixture?.agent ?? createRagAgent(),
        services: { chatModels: { mock: replay.model } },
        models: reviewRouting,
        bindings: {
          'docs.search@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 5000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            invoke: replay.search,
          },
        },
        ui: reviewRegistry.bindings({ surfaces: ['rag-review'] }),
      },
    );
    await instance.prepare();
    expect(await recordReview(instance, transcript)).toEqual({
      subgraph: true,
      text: 'Paris is the capital [1]. [9]',
    });
    expect(instance.getSnapshot().run?.labels).toContain('private-user');
    const replayed = [];
    const run = instance.getSnapshot().run;
    if (!run) throw new Error('The review run is missing.');
    for await (const event of instance.events(run.runId)) replayed.push(event.type);
    expect(replayed).not.toContain('stream');
  } finally {
    await runtime.dispose();
    await fixture?.cleanup();
  }
}

test(
  'review transcript and checked answer stream on Node: javascript',
  () => reviewOnNode('javascript'),
  30000,
);
test.skipIf(!pythonWheelsAvailable)(
  'review transcript and checked answer stream on Node: python',
  () => reviewOnNode('python'),
  30000,
);
