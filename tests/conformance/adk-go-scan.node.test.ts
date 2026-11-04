// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AgentSnapshot,
  createRuntime,
  type DevelopmentWarning,
  type DiagnosticEvent,
  defineAgentDefinition,
  type RunEvent,
} from '@galaxie/core';
import { openAICompatible } from '@galaxie/models/openai';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';
import { FakeOpenAIFetch } from '../../packages/models/test/support/fake-openai-fetch.js';
import {
  buildReference,
  disposeReference,
  goAvailable,
  missingGo,
  type NodeHost,
  startNodeHost,
} from './support/adk-go.node.js';

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

let host: NodeHost | undefined;
beforeAll(async () => {
  if (goAvailable) host = await startNodeHost(await buildReference());
}, 600000);
afterAll(async () => {
  await host?.close();
  await disposeReference();
});

test.skipIf(!goAvailable).each(['success', '401', 'transport-error'] as const)(
  goAvailable
    ? 'a credential stays in the injected request header across an ADK Go run (%s)'
    : missingGo,
  async (mode) => {
    if (!host) throw new Error('The host did not start.');
    const nodeHost = host;
    // Generated only in host test code, never supplied as agent input or model text.
    const canary = `fixture-provider-credential-${crypto.randomUUID()}`;
    const prompt = 'adk-go-scan-prompt-marker';
    const reply = 'adk-go-scan-reply-marker';
    const { exporter, provider } = createSpanRecorder();
    const diagnostics: DiagnosticEvent[] = [];
    const warnings: DevelopmentWarning[] = [];
    const snapshots: AgentSnapshot<unknown>[] = [];
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fake = new FakeOpenAIFetch({ text: reply });
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
    const trafficStart = nodeHost.traffic.length;
    const runtime = createRuntime({
      appId: 'adk-go-scan',
      executors: [createGoAdapter({ createWorker: () => nodeHost.createWorker() })],
      tracerProvider: provider,
      diagnostics: (event) => diagnostics.push(event),
      developmentWarnings: (warning) => warnings.push(warning),
      outputSafety: () => 'allow',
    });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'conformance/adk-go-scan',
          version: '1.0.0',
          executor: 'adk-go',
          input: z.object({ prompt: z.string() }),
          models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        }),
        {
          principalScope: 'fixture',
          agent: { wasm: nodeHost.wasm, entry: 'single' },
          services: {
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
                features: [],
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
      const traffic = nodeHost.traffic.slice(trafficStart).join('\n');
      expect(traffic).toContain(prompt);
      expect(traffic).not.toContain(canary);
      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      const telemetry = serialize({ diagnostics, warnings }) + serializeSpans(spans);
      for (const marker of [canary, prompt, reply]) expect(telemetry).not.toContain(marker);
      expect(serialize({ events, snapshots })).not.toContain(canary);
      // Positive controls: the scanner sees non-enumerable errors and bytes.
      expect(serialize(new Error(canary))).toContain(canary);
      expect(serialize({ bytes: new TextEncoder().encode(canary) })).toContain(canary);
      expect(`page>${JSON.stringify({ payload: canary })}`).toContain(canary);
    } finally {
      await runtime.dispose();
      await provider.shutdown();
    }
  },
  120000,
);
