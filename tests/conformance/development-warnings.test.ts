// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createLangGraphAdapter,
  type LangGraphAgent,
  requestInteraction,
} from '@galaxie/adapter-langgraph';
import {
  createRuntime,
  type DevelopmentWarning,
  type DiagnosticEvent,
  defineAgentDefinition,
  type ModelAvailability,
  type ModelAvailabilityRequest,
} from '@galaxie/core';
import { MockChatModel } from '@galaxie/models/mock';
import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';

const prompt = 'development warning fixture';
const blockedUrl = 'https://blocked.example/synthetic-query?value=model-text';
const runtimes: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
});

async function fixture(
  options: { enabled?: boolean; url?: boolean; initiallyUnavailable?: boolean } = {},
) {
  const warnings: DevelopmentWarning[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const availability = vi.fn(
    (_request: ModelAvailabilityRequest): ModelAvailability => ({
      status: 'available' as const,
    }),
  );
  if (options.initiallyUnavailable) availability.mockReturnValueOnce({ status: 'unavailable' });
  const runtime = createRuntime({
    appId: 'development-conformance',
    executors: [createLangGraphAdapter()],
    outputSafety: () => 'allow',
    diagnostics: (event) => diagnostics.push(event),
    ...(options.enabled
      ? { developmentWarnings: (warning: DevelopmentWarning) => warnings.push(warning) }
      : {}),
  });
  runtimes.push(runtime);
  const model = new MockChatModel({
    [prompt]: {
      id: 'warning-fixture-reply',
      text: options.url ? blockedUrl : 'plain fixture reply',
    },
  });
  const agent: LangGraphAgent = (host) => {
    const state = Annotation.Root({ text: Annotation<string> });
    const chat = host.langchain.chatModel('assistant');
    return new StateGraph(state)
      .addNode('respond', async (_state, config) => ({
        text: (await chat.invoke([new HumanMessage(prompt)], config)).content as string,
      }))
      .addNode('ask', async ({ text }, config) => {
        requestInteraction(
          {
            surfaceId: 'main',
            viewRevision: 'v1',
            component: 'tests.Question/v1',
            props: { text },
          },
          config,
        );
        return {};
      })
      .addEdge(START, 'respond')
      .addEdge('respond', 'ask')
      .addEdge('ask', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/development-warnings',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.unknown(),
      models: { assistant: { modality: 'text' } },
    }),
    {
      agent,
      principalScope: 'test',
      services: { chatModels: { local: model } },
      models: {
        providers: {
          local: {
            modality: 'text',
            destination: 'in-browser',
            features: ['streaming'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { assistant: { providers: ['local'], allow: ['in-browser'], maxTokens: 100 } },
        availability,
      },
    },
  );
  await instance.prepare();
  const { runId } = await instance.start({ text: prompt });
  for await (const event of instance.events(runId))
    if (event.type === 'interaction' || event.type === 'error' || event.type === 'output') break;
  return { runtime, instance, warnings, diagnostics, availability };
}

test('a real LangGraph interrupt warns about a blocked model URL without publishing its text', async () => {
  const { instance, warnings, diagnostics } = await fixture({ enabled: true, url: true });
  expect(instance.getSnapshot().run).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect(instance.getSnapshot().run?.pending).toBeUndefined();
  expect(warnings.filter(({ code }) => code === 'url_blocked')).toEqual([
    { code: 'url_blocked', instanceId: instance.instanceId },
  ]);
  expect(JSON.stringify({ warnings, diagnostics, snapshot: instance.getSnapshot() })).not.toMatch(
    /blocked\.example|synthetic-query|model-text/,
  );
});

test('creation availability advice does not change later routing', async () => {
  const { instance, warnings, availability } = await fixture({
    enabled: true,
    initiallyUnavailable: true,
  });
  expect(warnings.filter(({ code }) => code === 'role_without_provider')).toEqual([
    { code: 'role_without_provider', instanceId: instance.instanceId, name: 'assistant' },
  ]);
  expect(availability).toHaveBeenCalledTimes(2);
  expect(instance.getSnapshot().run?.status).toBe('waiting_input');
  expect(instance.getSnapshot().routes?.['assistant']).toEqual({
    providerId: 'local',
    destination: 'in-browser',
  });
});

test('with the option absent a complete mock run emits no warnings or extra availability probe', async () => {
  const { instance, warnings, availability } = await fixture();
  const pending = instance.getSnapshot().run?.pending;
  const runId = instance.getSnapshot().run?.runId;
  expect(pending).toBeDefined();
  if (pending === undefined || runId === undefined) throw new Error('The fixture did not pause.');
  expect(
    await instance.dispatch({
      ...pending,
      instanceId: instance.instanceId,
      runId,
      action: 'submit',
      payload: null,
    }),
  ).toMatchObject({ status: 'accepted' });
  await collect(instance.events(runId));
  expect(instance.getSnapshot().run?.status).toBe('succeeded');
  expect(availability).toHaveBeenCalledTimes(1);
  expect(warnings).toEqual([]);
});

test.skipIf(typeof document === 'undefined')(
  'Chromium page checks detect unenforced policies and a synthetic stored key',
  async () => {
    const key = 'galaxie-development-warning-test';
    try {
      localStorage.setItem(key, `sk-${'x'.repeat(20)}`);
      const { warnings } = await fixture({ enabled: true });
      expect(warnings).toContainEqual({ code: 'trusted_types_unenforced' });
      expect(warnings).toContainEqual({ code: 'csp_unenforced', name: 'script-src' });
      expect(warnings).toContainEqual({ code: 'provider_key_in_storage', area: 'localStorage' });
      expect(JSON.stringify(warnings)).not.toContain(key);
      expect(JSON.stringify(warnings)).not.toContain(`sk-${'x'.repeat(20)}`);
    } finally {
      localStorage.removeItem(key);
    }
  },
);

test.skipIf(typeof document === 'undefined')(
  'Chromium with the option absent never accesses eval or the template HTML sink',
  async () => {
    const functionProbe = vi.spyOn(globalThis, 'Function');
    const htmlProbe = vi.spyOn(Element.prototype, 'innerHTML', 'set');
    const { instance, warnings } = await fixture();
    expect(instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(functionProbe).not.toHaveBeenCalled();
    expect(htmlProbe).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  },
);
