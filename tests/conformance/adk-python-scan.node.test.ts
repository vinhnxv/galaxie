// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentSnapshot,
  createRuntime,
  type DevelopmentWarning,
  type DiagnosticEvent,
  defineAgentDefinition,
  type RunEvent,
} from '@galaxie-ai/core';
import { openAICompatible } from '@galaxie-ai/models/openai';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { FakeOpenAIFetch } from '../../packages/models/test/support/fake-openai-fetch.js';
import { adkPythonSources } from './support/adk-python-sources.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

/** Stringifies what a scan must see: error fields that JSON hides, bytes and maps. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error)
      return Object.fromEntries(
        Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)]),
      );
    if (item instanceof Uint8Array) return new TextDecoder().decode(item);
    if (item instanceof Map) return [...item];
    return item;
  });
}

/** A bridge message with its base64 byte fields decoded, so encoding cannot hide a credential. */
function decoded(raw: string): string {
  return raw.replace(/"bytes":"([A-Za-z0-9+/=]*)"/g, (_match, text: string) =>
    JSON.stringify(Buffer.from(text, 'base64').toString('utf8')),
  );
}

test.skipIf(!pythonWheelsAvailable).each(['success', '401', 'transport-error'] as const)(
  pythonWheelsAvailable
    ? 'a credential stays in the injected request header across an ADK Python run (%s)'
    : missingPythonWheels,
  async (mode) => {
    // Generated only in host test code, never supplied as agent input or model text.
    const canary = `fixture-provider-credential-${crypto.randomUUID()}`;
    const prompt = 'adk-python-scan-prompt-marker';
    const reply = 'adk-python-scan-reply-marker';
    const fixture = await createPythonFixture({
      framework: 'adk',
      sources: await adkPythonSources('plain-text'),
      module: 'selected',
    });
    const { exporter, provider } = createSpanRecorder();
    const diagnostics: DiagnosticEvent[] = [];
    const warnings: DevelopmentWarning[] = [];
    const snapshots: AgentSnapshot<unknown>[] = [];
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fake = new FakeOpenAIFetch({ deltas: [{ role: 'assistant', content: reply }] });
    const injectedFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: await request.clone().text(),
      });
      if (mode === 'transport-error') throw new Error(`Host transport failed: ${canary}`);
      if (mode === '401')
        return Response.json({ error: { message: `Rejected ${canary}` } }, { status: 401 });
      return fake.fetch(request);
    };
    const getCredential = vi.fn(() => canary);
    const checkpoints = new MemoryByteCheckpoints();
    const recovery = new MemoryRecoveryStore();
    const runtime = createRuntime({
      appId: 'adk-python-scan',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
      tracerProvider: provider,
      diagnostics: (event) => diagnostics.push(event),
      developmentWarnings: (warning) => warnings.push(warning),
      outputSafety: () => 'allow',
    });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'conformance/adk-python-scan',
          version: '1.0.0',
          executor: 'adk-python',
          input: z.object({ prompt: z.string() }),
          models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        }),
        {
          principalScope: 'fixture',
          agent: fixture.agent,
          recovery,
          services: {
            checkpoints,
            chatModels: {
              proxy: openAICompatible({
                baseURL: 'http://127.0.0.1:1/v1',
                model: 'mock-credential-scan',
                fetch: injectedFetch,
              }),
            },
          },
          models: {
            providers: {
              proxy: {
                destination: 'host-server',
                modality: 'text',
                languages: ['en'],
                features: ['streaming'],
                pricing: { inputPerToken: 0, outputPerToken: 0 },
                credential: true,
              },
            },
            roles: { answer: { providers: ['proxy'], allow: ['host-server'], maxTokens: 100 } },
            consent: () => true,
            getCredential,
          },
        },
      );
      const unsubscribe = instance.subscribe(() => snapshots.push(instance.getSnapshot()));
      await instance.prepare();
      const { runId } = await instance.start({ prompt });
      const events: RunEvent[] = [];
      for await (const event of instance.events(runId)) events.push(event);
      unsubscribe();
      if (mode === 'success') {
        expect(events.at(-1)).toMatchObject({ type: 'output', output: reply });
      } else {
        expect(events.at(-1)).toMatchObject({ type: 'error' });
        expect((events.at(-1) as { error: { code: string } }).error.code).toMatch(
          /^(unavailable|denied|unreachable)$/,
        );
      }
      await runtime.dispose();
      await provider.forceFlush();
      expect(getCredential).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:1/v1/chat/completions');
      expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${canary}`);
      expect(requests[0]?.body).toContain(prompt);
      const otherHeaders = [...(requests[0]?.headers ?? [])].filter(
        ([name]) => name !== 'authorization',
      );
      expect(serialize({ body: requests[0]?.body, headers: otherHeaders })).not.toContain(canary);
      // The Python side sees the prompt and the checked reply, never the credential.
      const traffic = [...fixture.toWorker, ...fixture.fromWorker].map(decoded).join('\n');
      expect(traffic).toContain(prompt);
      expect(traffic).not.toContain(canary);
      expect(fixture.workerErrors).toEqual([]);
      const spans = exporter.getFinishedSpans();
      expect(
        spans.some((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent'),
      ).toBe(true);
      const telemetry = serialize({ diagnostics, warnings }) + serializeSpans(spans);
      for (const marker of [canary, prompt, reply]) expect(telemetry).not.toContain(marker);
      expect(serialize({ events, snapshots })).not.toContain(canary);
      expect(serialize([...checkpoints.rows.values()])).not.toContain(canary);
      expect(serialize([...recovery.journal.values()])).not.toContain(canary);
      expect(serialize(await recovery.submissions(instance.sessionId))).not.toContain(canary);
      // Positive controls: the scanner sees non-enumerable errors, bytes and encoded fields.
      expect(serialize(new Error(canary))).toContain(canary);
      expect(serialize({ bytes: new TextEncoder().encode(canary) })).toContain(canary);
      expect(decoded(`{"bytes":"${Buffer.from(canary).toString('base64')}"}`)).toContain(canary);
      if (mode === 'success') expect(checkpoints.rows.size).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await provider.shutdown();
      await fixture.cleanup();
    }
  },
  120000,
);
