// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter, requestInteraction } from '@galaxie/adapter-langgraph';
import {
  type AgentSnapshot,
  createManifest,
  createRuntime,
  type DevelopmentWarning,
  type DiagnosticEvent,
} from '@galaxie/core';
import { tutorDefinition } from '@galaxie/example-english-tutor';
import { openAICompatible } from '@galaxie/models/openai';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph/web';
import { expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { FakeOpenAIFetch } from '../../packages/models/test/support/fake-openai-fetch.js';

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    // Error.message/stack are not enumerable. Checkpoint envelopes contain bytes,
    // which JSON alone would turn into numbers and hide a credential string.
    if (item instanceof Error)
      return Object.fromEntries(
        Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)]),
      );
    if (item instanceof Uint8Array) return new TextDecoder().decode(item);
    if (item instanceof ArrayBuffer) return new TextDecoder().decode(item);
    if (item instanceof Map) return [...item];
    return item;
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedRecords(): Promise<
  Array<{ database: string; store: string; keys: IDBValidKey[]; records: unknown[] }>
> {
  const result: Awaited<ReturnType<typeof storedRecords>> = [];
  // Enumerate the origin, rather than assuming only the fixture database exists.
  for (const info of await indexedDB.databases()) {
    if (info.name === undefined) throw new Error('A database has no name.');
    const database = await requestResult(indexedDB.open(info.name));
    try {
      for (const store of database.objectStoreNames) {
        const objectStore = database.transaction(store, 'readonly').objectStore(store);
        const [keys, records] = await Promise.all([
          requestResult(objectStore.getAllKeys()),
          requestResult(objectStore.getAll()),
        ]);
        result.push({ database: info.name, store, keys, records });
      }
    } finally {
      database.close();
    }
  }
  return result;
}

test.each(['success', '401', 'transport-error'] as const)(
  'AT-23: credentials stay in injected request authorization headers (%s)',
  async (mode) => {
    // Generated only in host test code, never supplied as agent input or model text.
    const canary = `fixture-provider-credential-${crypto.randomUUID()}`;
    const prompt = 'credential-scan-prompt-marker';
    const reply = 'credential-scan-reply-marker';
    const databaseName = `galaxie-credential-scan-${crypto.randomUUID()}`;
    const saver =
      typeof indexedDB === 'undefined'
        ? undefined
        : await IndexedDBSaver.open({
            databaseName,
            appId: 'credential-scan',
            principalScope: 'test',
          });
    const checkpointer = saver ?? new MemorySaver();
    const recovery = saver?.recovery ?? new MemoryRecoveryStore();
    const { exporter, provider } = createSpanRecorder();
    const diagnostics: DiagnosticEvent[] = [];
    const warnings: DevelopmentWarning[] = [];
    const snapshots: AgentSnapshot<unknown>[] = [];
    const errors: unknown[] = [];
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fake = new FakeOpenAIFetch({ text: reply });
    const injectedFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: await request.clone().text(),
      });
      if (requests.length === 2) {
        if (mode === 'transport-error') throw new Error(`Host transport failed: ${canary}`);
        if (mode === '401')
          return Response.json({ error: { message: `Rejected ${canary}` } }, { status: 401 });
      }
      return fake.fetch(request);
    };
    const getCredential = vi.fn(() => canary);
    const runtime = createRuntime({
      appId: 'credential-scan',
      executors: [createLangGraphAdapter()],
      tracerProvider: provider,
      diagnostics: (event) => diagnostics.push(event),
      developmentWarnings: (warning) => warnings.push(warning),
    });
    onTestFinished(async () => {
      await runtime.dispose();
      await provider.shutdown();
      saver?.close();
      if (saver !== undefined) {
        const request = indexedDB.deleteDatabase(databaseName);
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('Credential scan cleanup was blocked.'));
        });
      }
    });
    const instance = await runtime.create(
      {
        id: 'conformance/credential-scan',
        version: '1.0.0',
        executor: 'langgraph-js',
        input: z.object({}),
        models: { assistant: { modality: 'text' } },
      },
      {
        principalScope: 'test',
        recovery,
        services: {
          checkpointer,
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
              features: [],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
              credential: true,
            },
          },
          roles: { assistant: { providers: ['proxy'], allow: ['host-server'], maxTokens: 100 } },
          consent: () => true,
          getCredential,
        },
        agent: (host) => {
          const state = Annotation.Root({ completed: Annotation<boolean> });
          const respond = async (
            _state: unknown,
            config: Parameters<typeof requestInteraction>[1],
          ) => {
            const model = host.langchain.chatModel('assistant');
            model.disableStreaming = true;
            try {
              // Native nostream plus projection keeps model text out of this fixture's
              // events/state. This is fixture behavior, not SDK stream redaction.
              await model.invoke(prompt, { ...config, tags: ['nostream'] });
            } catch (error) {
              errors.push(error);
              throw error;
            }
            return { completed: true };
          };
          return new StateGraph(state)
            .addNode('before', respond)
            .addNode('ask', (_state, config) => {
              requestInteraction(
                {
                  surfaceId: 'main',
                  component: 'conformance.Question/v1',
                  viewRevision: 'v1',
                  props: { question: 'Continue?' },
                },
                config,
              );
              return {};
            })
            .addNode('after', respond)
            .addEdge(START, 'before')
            .addEdge('before', 'ask')
            .addEdge('ask', 'after')
            .addEdge('after', END)
            .compile({ checkpointer: host.langchain.checkpointer() });
        },
      },
    );
    const unsubscribe = instance.subscribe(() => snapshots.push(instance.getSnapshot()));
    onTestFinished(unsubscribe);
    await instance.prepare();
    const { runId } = await instance.start({});
    await expect.poll(() => instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(requests).toHaveLength(1);
    const pausedRecords = saver === undefined ? [] : await storedRecords();
    expect(serialize(pausedRecords)).not.toContain(canary);
    const pending = instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('The scan fixture did not pause.');
    expect(
      await instance.dispatch({
        instanceId: instance.instanceId,
        runId,
        ...pending,
        action: 'submit',
        payload: {},
      }),
    ).toMatchObject({ status: 'accepted' });
    const events = await collect(instance.events(runId));
    expect(instance.getSnapshot().run?.status).toBe(mode === 'success' ? 'succeeded' : 'failed');
    if (mode === 'success') {
      expect(events.at(-1)).toMatchObject({ type: 'output', output: { completed: true } });
      expect(errors).toEqual([]);
    } else {
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: 'The model provider is unavailable.' });
      expect(errors[0]).not.toHaveProperty('cause');
      expect(diagnostics.some((event) => event.kind === 'run_failed')).toBe(true);
    }
    await runtime.dispose();
    await provider.forceFlush();
    expect(getCredential).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe('http://127.0.0.1:1/v1/chat/completions');
      expect(request.headers.get('authorization')).toBe(`Bearer ${canary}`);
      expect(request.body).toContain(prompt);
      const otherHeaders = [...request.headers].filter(([name]) => name !== 'authorization');
      expect(
        serialize({ url: request.url, body: request.body, headers: otherHeaders }),
      ).not.toContain(canary);
    }
    const spans = exporter.getFinishedSpans();
    expect(
      spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat'),
    ).toHaveLength(2);
    const telemetry =
      serialize({ events, snapshots, diagnostics, warnings, errors }) + serializeSpans(spans);
    for (const marker of [canary, prompt, reply]) expect(telemetry).not.toContain(marker);
    const exports = createManifest(tutorDefinition, { entry: './src/index.ts' });
    expect(Object.keys(exports.schemas).length).toBeGreaterThan(0);
    expect(serialize(exports)).not.toContain(canary);
    const checkpoints = [];
    for await (const checkpoint of checkpointer.list({
      configurable: { thread_id: instance.sessionId },
    }))
      checkpoints.push(checkpoint);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(serialize(checkpoints)).not.toContain(canary);
    expect(serialize(await recovery.submissions(instance.sessionId))).not.toContain(canary);
    if (saver !== undefined) {
      const records = await storedRecords();
      for (const store of ['checkpoints', 'writes', 'inbox', 'journal', 'meta'])
        expect(
          records.some((entry) => entry.database === databaseName && entry.store === store),
        ).toBe(true);
      expect(
        records.find((entry) => entry.database === databaseName && entry.store === 'inbox')?.records
          .length,
      ).toBeGreaterThan(0);
      expect(serialize(records)).not.toContain(canary);
    }
    // Positive controls: the scanner sees non-enumerable errors and binary envelopes.
    expect(serialize(new Error(canary))).toContain(canary);
    expect(serialize({ bytes: new TextEncoder().encode(canary) })).toContain(canary);
  },
);
