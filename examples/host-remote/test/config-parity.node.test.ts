// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BindingsFor, CapabilityContext, ModelRouting } from '@galaxie-ai/core';
import { httpCapability } from '@galaxie-ai/core';
import { buildHostConfig, buildRuntimeLimits, HostConfigError } from '@galaxie-ai/core/config';
import type { tutorDefinition } from '@galaxie-ai/example-english-tutor';
import { openAICompatible } from '@galaxie-ai/models/openai';
import { createServer } from 'vite';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { backend } from '../server/backend.js';
import type { RemoteHostHooks } from '../src/host-config.js';
import { document, validateRemoteHost } from '../src/host-config.js';

const origin = 'http://127.0.0.1:4321';
const hooks: RemoteHostHooks = {
  headers: () => ({ authorization: 'Bearer test-only-placeholder' }),
  consent: () => true,
  getCredential: () => 'host-remote-placeholder',
};

// The pre-migration wiring is an independent oracle; never derive it from the document.
function handWired(): {
  bindings: BindingsFor<typeof tutorDefinition>;
  modelRouting: ModelRouting;
} {
  const policy = {
    destination: 'host-server',
    timeoutMs: 10_000,
    concurrency: 1,
    grantScope: 'run',
    retry: 'none',
    credentials: 'omit',
    headers: hooks.headers,
  } as const;
  const bindings: BindingsFor<typeof tutorDefinition> = {
    'lessons.get@1': httpCapability({
      ...policy,
      method: 'GET',
      kind: 'read',
      approval: 'none',
      url: `${origin}/api/lessons/{lessonId}`,
    }),
    'progress.save@1': httpCapability({
      ...policy,
      method: 'POST',
      kind: 'write',
      approval: 'confirm',
      url: `${origin}/api/progress`,
    }),
  };
  const modelRouting: ModelRouting = {
    providers: {
      quiz: {
        destination: 'host-server',
        modality: 'text',
        features: ['streaming', 'cancellation', 'structured-output'],
        languages: ['en'],
        pricing: { inputPerToken: 0, outputPerToken: 0 },
        credential: true,
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
    consent: hooks.consent,
    getCredential: hooks.getCredential,
  };
  return { bindings, modelRouting };
}

afterEach(() => vi.unstubAllGlobals());

test('the shipped file validates against the tutor definition with host-owned hooks', () => {
  expect(() => validateRemoteHost(origin, hooks)).not.toThrow();
});

test('config-built capability policies equal the pre-migration bindings', () => {
  const configured = buildHostConfig(validateRemoteHost(origin, hooks));
  const manual = handWired();
  expect(Object.keys(configured.bindings).sort()).toEqual(['lessons.get@1', 'progress.save@1']);
  for (const name of ['lessons.get@1', 'progress.save@1'] as const) {
    const { invoke: _configuredInvoke, ...actual } = configured.bindings[name];
    const { invoke: _manualInvoke, ...expected } = manual.bindings[name];
    expect(actual).toEqual(expected);
  }
});

test('config-built bindings send the same requests as hand-built bindings', async () => {
  const configured = buildHostConfig(validateRemoteHost(origin, hooks));
  const context: CapabilityContext = {
    signal: new AbortController().signal,
    effectId: 'effect-1' as CapabilityContext['effectId'],
    runId: 'run-1' as CapabilityContext['runId'],
    principalScope: 'demo-learner',
    agent: { id: 'test-tutor', version: '0.1.0', hash: '' },
  };
  const records: unknown[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
    records.push({
      url: String(url),
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body,
      credentials: init.credentials,
      redirect: init.redirect,
    });
    return Response.json({});
  });
  const expected = [
    {
      url: 'http://127.0.0.1:4321/api/lessons/present-simple-1',
      method: 'GET',
      headers: {
        authorization: 'Bearer test-only-placeholder',
        'x-galaxie-agent': 'test-tutor@0.1.0',
        'x-galaxie-run': 'run-1',
      },
      body: undefined,
      credentials: 'omit',
      redirect: 'error',
    },
    {
      url: 'http://127.0.0.1:4321/api/progress',
      method: 'POST',
      headers: {
        authorization: 'Bearer test-only-placeholder',
        'content-type': 'application/json',
        'x-galaxie-agent': 'test-tutor@0.1.0',
        'x-galaxie-run': 'run-1',
      },
      body: '{"lessonId":"present-simple-1","score":2,"total":3}',
      credentials: 'omit',
      redirect: 'error',
    },
  ];
  for (const bindings of [handWired().bindings, configured.bindings]) {
    records.length = 0;
    await bindings['lessons.get@1'].invoke({ lessonId: 'present-simple-1' }, context);
    await bindings['progress.save@1'].invoke(
      { lessonId: 'present-simple-1', score: 2, total: 3 },
      context,
    );
    expect(records).toEqual(expected);
  }
});

test('config-built routing preserves descriptors, routes and exact hook identities', () => {
  const { modelRouting } = buildHostConfig(validateRemoteHost(origin, hooks));
  const normalize = (value: ModelRouting): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, child: unknown) =>
        typeof child === 'function' ? '[hook]' : child,
      ),
    );
  expect(normalize(modelRouting)).toEqual(normalize(handWired().modelRouting));
  expect(modelRouting.consent).toBe(hooks.consent);
  expect(modelRouting.getCredential).toBe(hooks.getCredential);
});

test('the quiz endpoint matches the old constructor options and runtime limits stay empty', () => {
  const validated = validateRemoteHost(origin, hooks);
  expect(buildHostConfig(validated).endpoints).toEqual({
    quiz: {
      baseURL: 'http://127.0.0.1:4321/api/v1',
      model: 'host-quiz',
      destination: 'host-server',
    },
  });
  expect(buildRuntimeLimits(validated)).toEqual({});
});

test('changing only the JSON model name changes the request recorded by the real proxy', async () => {
  const server = await createServer({
    configFile: false,
    mode: 'test',
    plugins: [backend()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  onTestFinished(() => server.close());
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port.');
  const baseURL = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${baseURL}/api/session`, {
    method: 'POST',
    headers: { origin: baseURL },
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toMatch(/^galaxie-agent-session=.+/);
  const { token } = (await response.json()) as { token: string };
  const sessionFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('origin', baseURL);
    headers.set('cookie', cookie!);
    return fetch(input, { ...init, headers });
  };
  const renamed = structuredClone(document);
  renamed.models.providers.quiz.endpoint.model = 'quiz-config-only';
  for (const configuration of [document, renamed]) {
    const { endpoints } = buildHostConfig(validateRemoteHost(baseURL, hooks, configuration));
    const endpoint = endpoints['quiz'];
    if (endpoint === undefined) throw new Error('Missing quiz endpoint.');
    const model = openAICompatible({ ...endpoint, fetch: sessionFetch })({
      credential: 'host-remote-placeholder',
    });
    await model.invoke('Make a quiz about the present simple.');
  }
  const state = await fetch(`${baseURL}/api/__test/state`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(state.status).toBe(200);
  const { proxyBodies } = (await state.json()) as { proxyBodies: { model: string }[] };
  expect(proxyBodies.map((body) => body.model)).toEqual(['host-quiz', 'quiz-config-only']);
});

test('an undeclared capability fails with its fixed code and JSON Pointer', () => {
  // Control: the original capability is present and accepted by this same validator.
  expect(document.capabilities['lessons.get@1']).toBeDefined();
  expect(() => validateRemoteHost(origin, hooks)).not.toThrow();
  const { 'lessons.get@1': lesson, ...rest } = structuredClone(document.capabilities);
  const renamed = {
    ...document,
    capabilities: { ...rest, 'lessons.fetch@1': lesson },
  };
  expect(() => validateRemoteHost(origin, hooks, renamed as unknown as typeof document)).toThrow(
    HostConfigError,
  );
  expect(() => validateRemoteHost(origin, hooks, renamed as unknown as typeof document)).toThrow(
    expect.objectContaining({ code: 'invalid', path: '/capabilities/lessons.fetch@1' }),
  );
});

test('an unknown headers hook fails at the configured capability headers entry', () => {
  const configuration = structuredClone(document);
  expect(configuration.capabilities['lessons.get@1'].headers).toBe('session');
  expect(() => validateRemoteHost(origin, hooks, configuration)).not.toThrow();
  configuration.capabilities['lessons.get@1'].headers = 'missing-session';
  expect(() => validateRemoteHost(origin, hooks, configuration)).toThrow(HostConfigError);
  expect(() => validateRemoteHost(origin, hooks, configuration)).toThrow(
    expect.objectContaining({ code: 'invalid', path: '/capabilities/lessons.get@1/headers' }),
  );
});
