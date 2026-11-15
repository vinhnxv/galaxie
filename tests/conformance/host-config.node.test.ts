// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentDefinition,
  type CapabilityBinding,
  createRuntime,
  httpCapability,
} from '@galaxie-ai/core';
import {
  buildHostConfig,
  type HostConfigDocument,
  validateHostConfig,
} from '@galaxie-ai/core/config';
import { tutorDefinition } from '@galaxie-ai/example-english-tutor';
import { openAICompatible } from '@galaxie-ai/models/openai';
import { createMcpServer } from '@galaxie-ai/tools-mcp';
import { expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { collect, FakeExecutor } from '../../packages/core/test/fake-executor.js';

const definition: AgentDefinition = { ...tutorDefinition, executor: 'fake' };
const lesson = {
  id: 'lesson-1',
  title: 'Lesson',
  grammarPoint: 'Tenses',
  content: 'Read this.',
  rubric: 'Practice.',
};
const headers = (): HeadersInit => ({ authorization: 'Bearer test-only-placeholder' });
const consent = (): boolean => true;
const getCredential = (): string => 'test-only-placeholder';
const modelHooks = { consent: { notice: consent }, getCredential: { model: getCredential } };

function document(): HostConfigDocument {
  return {
    version: '0.1',
    capabilities: {
      'lessons.get@1': {
        kind: 'read',
        destination: 'host-server',
        timeoutMs: 10000,
        concurrency: 1,
        grantScope: 'run',
        retry: 'none',
        approval: 'none',
        credentials: 'omit',
        method: 'GET',
        url: '/api/lessons/{lessonId}',
        headers: 'session',
        fetch: 'transport',
      },
      'progress.save@1': {
        kind: 'write',
        destination: 'host-server',
        timeoutMs: 10000,
        concurrency: 1,
        grantScope: 'run',
        retry: 'none',
        approval: 'confirm',
        credentials: 'omit',
        method: 'POST',
        url: '/api/progress',
        headers: 'session',
        fetch: 'transport',
      },
    },
    models: {
      consent: 'notice',
      getCredential: 'model',
      providers: {
        quiz: {
          destination: 'host-server',
          modality: 'text',
          features: ['streaming', 'cancellation', 'structured-output'],
          languages: ['en'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
          credential: true,
          endpoint: { baseURL: '/api/v1', model: 'host-quiz' },
        },
        feedback: {
          destination: 'in-browser',
          modality: 'text',
          features: ['streaming', 'cancellation', 'structured-output'],
          languages: ['en'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles: {
        'quiz.generate': { providers: ['quiz'], allow: ['host-server'], maxTokens: 2000 },
        'tutor.feedback': { providers: ['feedback'], allow: ['in-browser'], maxTokens: 1000 },
      },
    },
  };
}

function transport(): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(String(url).includes('/lessons/') ? lesson : { saved: true }),
  );
}

async function runCalls(
  bindings: Readonly<Record<string, CapabilityBinding<never>>>,
  fetch: ReturnType<typeof transport>,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const executor = new FakeExecutor([
    async function* ({ capabilities }) {
      results.push(await capabilities.call('lessons.get@1', { lessonId: 'lesson-1' }));
      results.push(
        await capabilities.call('progress.save@1', { lessonId: 'lesson-1', score: 2, total: 3 }),
      );
      yield { type: 'output', output: 'saved' };
    },
  ]);
  const runtime = createRuntime({ appId: 'config-conformance', executors: [executor] });
  onTestFinished(() => runtime.dispose());
  const instance = await runtime.create(definition, {
    principalScope: 'learner',
    agent: {},
    bindings,
    confirmations: { capabilities: ['progress.save@1'], policyRevision: () => 'v1' },
    models: buildHostConfig(
      validateHostConfig(
        { version: '0.1', models: document().models },
        definition,
        modelHooks,
        'https://app.example',
      ),
    ).modelRouting,
  });
  await instance.prepare();
  const { runId } = await instance.start(
    { lessonId: 'lesson-1' },
    { grants: ['lessons.get@1', 'progress.save@1'] },
  );
  const events = collect(instance.events(runId));
  await vi.waitFor(() => expect(instance.getSnapshot().confirmations).toHaveLength(1));
  expect(fetch).toHaveBeenCalledTimes(1);
  const confirmation = instance.getSnapshot().confirmations?.[0];
  if (confirmation === undefined) throw new Error('Missing confirmation.');
  expect(confirmation.capability).toBe('progress.save@1');
  expect(instance.respond(confirmation.id, 'approve')).toEqual({ status: 'approved' });
  await events;
  expect(results).toEqual([lesson, { saved: true }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  return fetch.mock.calls.map(([url, init]) => {
    const sent = new Headers(init?.headers);
    expect(sent.get('X-Galaxie-Agent')).toBe('galaxie.english-tutor@0.0.0');
    expect(sent.get('X-Galaxie-Run')).toBe(runId);
    return {
      url,
      method: init?.method,
      credentials: init?.credentials,
      redirect: init?.redirect,
      authorization: sent.get('authorization'),
      body: init?.body,
    };
  });
}

test('config-built tutor calls match independent hand-wired requests and wait for write approval', async () => {
  const configuredFetch = transport();
  const config = validateHostConfig(
    document(),
    definition,
    { ...modelHooks, headers: { session: headers }, fetch: { transport: configuredFetch } },
    'https://app.example',
  );
  const configured = await runCalls(buildHostConfig(config).bindings, configuredFetch);
  const manualFetch = transport();
  const manual = await runCalls(
    {
      'lessons.get@1': httpCapability({
        kind: 'read',
        destination: 'host-server',
        timeoutMs: 10000,
        concurrency: 1,
        grantScope: 'run',
        retry: 'none',
        approval: 'none',
        credentials: 'omit',
        method: 'GET',
        url: 'https://app.example/api/lessons/{lessonId}',
        headers,
        fetch: manualFetch,
      }),
      'progress.save@1': httpCapability({
        kind: 'write',
        destination: 'host-server',
        timeoutMs: 10000,
        concurrency: 1,
        grantScope: 'run',
        retry: 'none',
        approval: 'confirm',
        credentials: 'omit',
        method: 'POST',
        url: 'https://app.example/api/progress',
        headers,
        fetch: manualFetch,
      }),
    },
    manualFetch,
  );
  const expected = [
    {
      url: 'https://app.example/api/lessons/lesson-1',
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      authorization: 'Bearer test-only-placeholder',
      body: undefined,
    },
    {
      url: 'https://app.example/api/progress',
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      authorization: 'Bearer test-only-placeholder',
      body: '{"lessonId":"lesson-1","score":2,"total":3}',
    },
  ];
  expect(configured).toEqual(expected);
  expect(manual).toEqual(expected);
});

test('endpoint construction retains URL restrictions and adds the documented destination check', () => {
  const built = buildHostConfig(
    validateHostConfig(
      document(),
      definition,
      { ...modelHooks, headers: { session: headers }, fetch: { transport: transport() } },
      'https://app.example',
    ),
  );
  expect(() => openAICompatible(built.endpoints['quiz']!)).not.toThrow();
  for (const baseURL of [
    'https://name:pass@app.example/v1',
    'https://app.example/v1?q=1',
    'https://app.example/v1#part',
  ]) {
    const invalid = {
      version: '0.1',
      models: {
        providers: {
          quiz: {
            destination: 'host-server',
            modality: 'text',
            features: [],
            pricing: 'unknown',
            endpoint: { baseURL, model: 'host-quiz' },
          },
        },
        roles: {},
      },
    };
    expect(() => validateHostConfig(invalid, definition, {}, 'https://app.example')).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(() => openAICompatible({ baseURL, model: 'host-quiz' })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
  }
  const baseURL = 'https://app.example/v1';
  expect(() =>
    openAICompatible({ baseURL, model: 'host-quiz', destination: 'user-device' }),
  ).not.toThrow();
  expect(() =>
    validateHostConfig(
      {
        version: '0.1',
        models: {
          providers: {
            quiz: {
              destination: 'user-device',
              modality: 'text',
              features: [],
              pricing: 'unknown',
              endpoint: { baseURL, model: 'host-quiz' },
            },
          },
          roles: {},
        },
      },
      definition,
      {},
      baseURL,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid', path: '/models/providers/quiz' }));
});

test('capability userinfo is refused only by the document and MCP query validation remains a builder seam', () => {
  const capability = {
    kind: 'read',
    destination: 'host-server',
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'run',
    retry: 'none',
    approval: 'none',
    method: 'GET',
    url: 'https://name:pass@app.example/api/lessons/{lessonId}',
  } as const;
  expect(() => httpCapability(capability)).not.toThrow();
  expect(() =>
    validateHostConfig(
      { version: '0.1', capabilities: { 'lessons.get@1': capability } },
      definition,
      {},
      'https://app.example',
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid' }));
  const server = {
    url: 'https://app.example/mcp?query=1',
    destination: 'host-server',
    token: 'session',
    tools: {},
  } as const;
  expect(() =>
    validateHostConfig(
      { version: '0.1', mcp: { servers: { school: server } } },
      definition,
      { token: { session: () => 'test-only-placeholder' } },
      'https://app.example',
    ),
  ).not.toThrow();
  expect(() =>
    createMcpServer({ ...server, id: 'school', token: () => 'test-only-placeholder' }),
  ).toThrow(expect.objectContaining({ code: 'invalid' }));
  const control = createMcpServer({
    ...server,
    id: 'school',
    url: 'https://app.example/mcp',
    token: () => 'test-only-placeholder',
  });
  onTestFinished(() => control.close());
});

test('the runtime broker finds config descriptors and rejects a weaker placeholder schema', async () => {
  const config = validateHostConfig(
    document(),
    definition,
    { ...modelHooks, headers: { session: headers }, fetch: { transport: transport() } },
    'https://app.example',
  );
  const bindings = buildHostConfig(config).bindings;
  const runtime = createRuntime({
    appId: 'descriptor-conformance',
    executors: [new FakeExecutor()],
  });
  onTestFinished(() => runtime.dispose());
  const options = {
    principalScope: 'learner',
    agent: {},
    bindings,
    models: buildHostConfig(config).modelRouting,
  };
  await expect(runtime.create(definition, options)).resolves.toBeDefined();
  const weaker: AgentDefinition = {
    ...definition,
    capabilities: {
      required: {
        ...tutorDefinition.capabilities.required,
        'lessons.get@1': {
          kind: 'read',
          input: z.object({ lessonId: z.string() }),
          output: z.unknown(),
        },
      },
    },
  };
  await expect(runtime.create(weaker, options)).rejects.toMatchObject({ code: 'invalid' });
});
