// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  type PythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { executeAdkPythonCase } from './support/adk-python.js';
import { executeAdkReloadStep } from './support/adk-python-restore.js';
import { adkPythonSources } from './support/adk-python-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const source = (model = "'answer'", loop = false): Record<string, string> => ({
  'selected.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from google.adk.agents import LlmAgent, LoopAgent
from galaxie.adk import llm
agent = LlmAgent(name='root', model=${model}, instruction='Answer briefly.')
def create_agent():
    return ${loop ? "LoopAgent(name='loop', max_iterations=3, sub_agents=[agent])" : 'agent'}
`,
});

async function host(fixture: PythonFixture, steps = 10, tokens = 1000) {
  const checks: string[] = [];
  const model = new MockChatModel({
    question: [
      {
        id: 'reply',
        text: 'done words',
        usage: {
          input_tokens: 2,
          output_tokens: 2,
          total_tokens: 4,
        },
      },
    ],
  });
  const runtime = createRuntime({
    appId: 'adk-role-inventory',
    executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
    budgets: { steps, tokens },
    outputSafety: ({ text }) => {
      checks.push(text);
      return 'allow';
    },
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'tests/adk-inventory',
      version: '1.0.0',
      executor: 'adk-python',
      input: z.object({ prompt: z.string() }),
      models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
    }),
    {
      principalScope: 'fixture',
      agent: fixture.agent,
      services: { chatModels: { mock: model } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            languages: ['en'],
            features: ['streaming'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 20 } },
      },
    },
  );
  return { runtime, instance, model, checks };
}

async function run(value: Awaited<ReturnType<typeof host>>) {
  const { runId } = await value.instance.start({ prompt: 'question' });
  const events = [];
  for await (const event of value.instance.events(runId)) {
    const { eventId: _eventId, runId: _runId, ...content } = event;
    events.push(content);
  }
  return {
    events,
    calls: value.model.calls,
    limits: value.model.maxTokens,
    checks: value.checks,
    labels: value.instance.getSnapshot().run?.labels,
  };
}

test.skipIf(!pythonWheelsAvailable)(
  'sequential and overlapping prepares use independent interpreters',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'selected',
      sources: source(),
    });
    const first = await host(fixture);
    const second = await host(fixture);
    let third: Awaited<ReturnType<typeof host>> | undefined;
    try {
      await first.instance.prepare();
      await second.instance.prepare();
      const a = await run(first);
      const b = await run(second);
      expect(a).toEqual(b);
      expect(a.events).toContainEqual(
        expect.objectContaining({ type: 'output', output: 'done words' }),
      );
      await first.runtime.dispose();
      third = await host(fixture);
      await third.instance.prepare();
      expect(await run(third)).toEqual(a);
      expect(fixture.counts.created).toBe(3);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await first.runtime.dispose();
      await second.runtime.dispose();
      await third?.runtime.dispose();
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'mapped and explicit models preserve streams, checks, labels and budget accounting',
  async () => {
    const observations = [];
    for (const model of ["'answer'", "llm('answer')"]) {
      const fixture = await createPythonFixture({
        framework: 'adk',
        module: 'selected',
        sources: source(model),
      });
      const current = await host(fixture);
      const limited = await host(fixture, 10, 1);
      try {
        await current.instance.prepare();
        await limited.instance.prepare();
        const normal = await run(current);
        const refused = await run(limited);
        expect(refused.calls).toBe(0);
        expect(refused.events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            error: expect.objectContaining({ code: 'budget_exceeded' }),
          }),
        );
        expect(normal.checks.length).toBeGreaterThan(0);
        expect(normal.events.some((event) => event.type === 'stream')).toBe(true);
        observations.push({ normal, refused });
      } finally {
        await current.runtime.dispose();
        await limited.runtime.dispose();
        await fixture.cleanup();
      }
    }
    expect(observations[0]).toEqual(observations[1]);
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'an undeclared model refuses at prepare before model or checkpoint access',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'selected',
      sources: source("'undeclared'"),
    });
    const current = await host(fixture);
    try {
      await expect(current.instance.prepare()).rejects.toMatchObject({ code: 'unsupported' });
      expect(current.model.calls).toBe(0);
      expect(
        fixture.fromWorker
          .map((raw) => JSON.parse(raw))
          .filter(
            (message) =>
              message.kind === 'request' &&
              ['model', 'capability', 'checkpoint'].includes(message.op),
          ),
      ).toEqual([]);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await current.runtime.dispose();
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'the mapped tree matches explicit routing under native conformance scripts',
  async () => {
    for (const name of [
      'stream-text',
      'step-budget',
      'agents-transfer',
      'stream-agents-sequential',
    ]) {
      const outcomes = [];
      for (const mapped of [false, true]) {
        const sources = await adkPythonSources(name);
        if (mapped)
          sources['suite.py'] =
            sources['suite.py']?.replace("model = llm('answer')", "model = 'answer'") ?? '';
        const fixture = await createPythonFixture({
          framework: 'adk',
          module: 'selected',
          sources,
        });
        try {
          outcomes.push(await executeAdkPythonCase(fixture.options, fixture.agent, name));
        } finally {
          await fixture.cleanup();
        }
      }
      expect(outcomes[0]).toEqual(outcomes[1]);
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'mapped and explicit loops settle reported usage before the same token limit',
  async () => {
    const outcomes = [];
    for (const model of ["'answer'", "llm('answer')"]) {
      const fixture = await createPythonFixture({
        framework: 'adk',
        module: 'selected',
        sources: source(model, true),
      });
      const current = await host(fixture, 10, 24);
      try {
        await current.instance.prepare();
        const result = await run(current);
        // Each call reserves 20 tokens, then settles four reported tokens. Two
        // calls fit; the third reservation fails with only sixteen left.
        expect(result.calls).toBe(2);
        expect(result.events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            error: expect.objectContaining({ code: 'budget_exceeded' }),
          }),
        );
        outcomes.push(result);
      } finally {
        await current.runtime.dispose();
        await fixture.cleanup();
      }
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  },
  900000,
);

function decoded(store: MemoryByteCheckpoints): unknown[] {
  const decode = (bytes: Uint8Array): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(bytes));
  return [...store.rows.values()].map((row) => {
    const checkpoint = decode(row.checkpoint.bytes);
    const metadata = decode(row.metadata.bytes);
    delete metadata['key'];
    for (const event of checkpoint['events'] as Record<string, unknown>[]) {
      const custom = event['customMetadata'] as Record<string, unknown> | undefined;
      if (custom?.['__adk_internal_fc_hmac']) {
        const stamps = custom['__adk_internal_fc_hmac'] as Record<string, string>;
        for (const key of Object.keys(stamps)) stamps[key] = 'MAC';
      }
    }
    return { id: row.id, parentId: row.parentId, checkpoint, metadata };
  });
}

async function deterministicSources(
  mapped: boolean,
  grouped: boolean,
  resumed: boolean,
): Promise<Record<string, string>> {
  const sources = await adkPythonSources('confirm-approve');
  if (mapped)
    sources['suite.py'] =
      sources['suite.py']?.replace("model = llm('answer')", "model = 'answer'") ?? '';
  if (grouped)
    sources['suite.py'] =
      sources['suite.py']?.replace("if name == 'toolset-fixed':", 'if True:') ?? '';
  // Deterministic test providers keep complete event IDs and timestamps comparable. Reloads
  // use a disjoint ID range, and the session's key and MAC remain independently random.
  sources['selected.py'] = `import itertools, uuid
from google.adk.platform import time as adk_time
_ids = itertools.count(${resumed ? 1000 : 1})
uuid.uuid4 = lambda: uuid.UUID(int=next(_ids))
adk_time.get_time = lambda: 1700000000.0
${sources['selected.py'] ?? ''}`;
  return sources;
}

test.skipIf(!pythonWheelsAvailable)(
  'mapped models and fixed toolsets keep complete decoded records through confirmation reload',
  async () => {
    const results = [];
    for (const [mapped, grouped] of [
      [false, false],
      [true, false],
      [false, true],
    ]) {
      const store = {
        checkpoints: new MemoryByteCheckpoints(),
        recovery: new MemoryRecoveryStore(),
      };
      const snapshots = [];
      const effects = [];
      let sessionId: string | undefined;
      let pending: unknown;
      let nodeIds = 1;
      for (const resumed of [false, true]) {
        const fixture = await createPythonFixture({
          framework: 'adk',
          module: 'selected',
          sources: await deterministicSources(mapped ?? false, grouped ?? false, resumed),
        });
        const ids = vi
          .spyOn(globalThis.crypto, 'randomUUID')
          .mockImplementation(
            () => `00000000-0000-4000-8000-${String(nodeIds++).padStart(12, '0')}`,
          );
        try {
          const result = await executeAdkReloadStep(fixture.options, fixture.agent, store, {
            name: 'confirm-approve',
            ...(sessionId === undefined ? {} : { sessionId }),
          });
          if (resumed) expect(result.restored).toEqual(pending);
          else {
            sessionId = result.sessionId;
            pending = result.pending;
            expect(pending).toBeDefined();
          }
          snapshots.push(decoded(store.checkpoints));
          effects.push(
            ...fixture.fromWorker
              .map((raw) => JSON.parse(raw))
              .filter((message) => message.kind === 'request' && message.op === 'capability')
              .map((message) => message.payload.effectScope),
          );
          expect(fixture.workerErrors).toEqual([]);
        } finally {
          ids.mockRestore();
          await fixture.cleanup();
        }
      }
      results.push({ snapshots, effects, pending });
    }
    // Both runtime and native ADK IDs come from deterministic test providers. Every
    // decoded record field remains, including event IDs, timestamps and revisions.
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  },
  900000,
);
