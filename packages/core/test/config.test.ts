// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  buildHostConfig,
  buildRuntimeLimits,
  type HostConfigDocument,
  HostConfigError,
  type HostConfigHooks,
  hostConfigJsonSchema,
  type ValidatedHostConfig,
  validateHostConfig,
} from '../src/config/index.js';
import { getHttpCapability } from '../src/http-capability.js';
import {
  type AgentDefinition,
  createRuntime,
  GalaxieError,
  httpCapability,
  toErrorInfo,
} from '../src/index.js';
import { binding, collect, definition, FakeExecutor } from './fake-executor.js';

const policy = {
  destination: 'host-server',
  timeoutMs: 10_000,
  concurrency: 1,
  grantScope: 'run',
  retry: 'none',
  credentials: 'omit',
} as const;
const idSchema = z.object({
  lessonId: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64),
});
const request = { input: idSchema, output: z.unknown(), kind: 'read' } as const;
const configDefinition: AgentDefinition = {
  ...definition,
  capabilities: {
    optional: {
      'lessons.get@1': request,
      'progress.save@1': {
        input: z.object({ lessonId: z.string(), score: z.number() }),
        output: z.unknown(),
        kind: 'write',
      },
      'mcp.school.lookup@1': request,
    },
  },
  models: { 'quiz.generate': { modality: 'text' }, 'tutor.feedback': { modality: 'text' } },
};

function document() {
  return {
    version: '0.1',
    capabilities: {
      'lessons.get@1': {
        ...policy,
        kind: 'read',
        approval: 'none',
        method: 'GET',
        url: '/api/lessons/{lessonId}',
        headers: 'session',
        fetch: 'transport',
      },
      'progress.save@1': {
        ...policy,
        kind: 'write',
        approval: 'confirm',
        method: 'POST',
        url: '/api/progress',
        headers: 'session',
        fetch: 'transport',
      },
    },
    models: {
      providers: {
        quiz: {
          destination: 'host-server',
          modality: 'text',
          features: ['streaming', 'cancellation', 'structured-output'],
          languages: ['en'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
          credential: true,
          endpoint: { baseURL: '/api/v1', model: 'host-quiz', fetch: 'transport' },
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
      consent: 'notice',
      getCredential: 'session',
      availability: 'ready',
      download: 'prepare',
    },
    mcp: {
      servers: {
        school: {
          url: '/mcp',
          destination: 'host-server',
          token: 'session',
          fetch: 'transport',
          tools: {
            lookup: {
              version: 1,
              pin: 'a'.repeat(64),
              kind: 'read',
              approval: 'none',
              timeoutMs: 1000,
              concurrency: 1,
              grantScope: 'run',
              retry: 'none',
            },
          },
        },
      },
    },
    limits: {
      budgets: {
        steps: 3,
        tokens: 4000,
        cost: 0,
        repairAttempts: 1,
        toolCalls: 2,
        wallClockMs: 1000,
        payloadBytes: 4096,
        uiElements: 5,
      },
      dataPolicy: {
        public: { allow: ['in-browser', 'host-server'] },
        app: { allow: ['host-server'] },
        'private-user': { allow: ['in-browser'] },
      },
      urlAllowlist: ['https://app.example'],
    },
  } satisfies HostConfigDocument;
}

function hostHooks() {
  return {
    headers: { session: vi.fn(() => ({ 'x-host-header-marker': 'test-placeholder' })) },
    fetch: { transport: vi.fn<typeof globalThis.fetch>(async () => Response.json({})) },
    token: { session: vi.fn(() => 'test-placeholder') },
    getCredential: { session: vi.fn(() => 'test-placeholder') },
    consent: { notice: vi.fn(() => true) },
    availability: { ready: vi.fn(() => ({ status: 'available' as const })) },
    download: { prepare: vi.fn(() => true) },
  } satisfies HostConfigHooks;
}

function validate(
  value: unknown = document(),
  agent: AgentDefinition = configDefinition,
  hooks: HostConfigHooks = hostHooks(),
  baseURL = 'https://app.example',
): ValidatedHostConfig {
  return validateHostConfig(value, agent, hooks, baseURL);
}

function rejected(action: () => unknown, path: string, code = 'invalid'): HostConfigError {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HostConfigError);
  const error = failure as HostConfigError;
  expect(error).toMatchObject({ code, path });
  let cause: unknown = error;
  while (cause instanceof Error) {
    expect(cause.message).toBe(toErrorInfo(error.code).message);
    expect(`${cause.name} ${cause.message}`).not.toMatch(
      /app\.example|evil\.example|x-host-header-marker|test-placeholder|session|transport|host-quiz|quiz|lessonId|apiKey/,
    );
    cause = cause.cause;
  }
  return error;
}

function assertFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) assertFrozen(child);
  }
}

test('validates a full document without invoking hooks and snapshots every container', () => {
  const input = document();
  const hooks = hostHooks();
  const result = validate(input, configDefinition, hooks);
  assertFrozen(result);
  for (const group of Object.values(hooks))
    for (const fn of Object.values(group)) expect(fn).not.toHaveBeenCalled();
  input.capabilities['lessons.get@1'].url = 'https://evil.example';
  input.models.roles['quiz.generate'].providers.push('feedback');
  hooks.fetch.transport = vi.fn();
  expect(result.document.capabilities?.['lessons.get@1']?.url).toBe(
    'https://app.example/api/lessons/{lessonId}',
  );
  expect(result.document.models?.roles['quiz.generate']?.providers).toEqual(['quiz']);
  expect(result.hooks.fetch?.['transport']).not.toBe(hooks.fetch.transport);
});

test.each([
  [{ version: '9.9' }, '/version', 'unsupported'],
  [{ version: 1 }, '/version', 'invalid'],
  [{}, '/version', 'invalid'],
  [{ ...document(), apiKey: 'test-placeholder' }, '/apiKey', 'invalid'],
  [
    {
      ...document(),
      capabilities: {
        'lessons.get@1': {
          ...document().capabilities['lessons.get@1'],
          apiKey: 'test-placeholder',
        },
      },
    },
    '/capabilities/lessons.get@1/apiKey',
    'invalid',
  ],
  [
    {
      ...document(),
      models: {
        ...document().models,
        providers: { quiz: { ...document().models.providers.quiz, apiKey: 'test-placeholder' } },
      },
    },
    '/models/providers/quiz/apiKey',
    'invalid',
  ],
  [
    {
      ...document(),
      mcp: {
        servers: {
          school: {
            ...document().mcp.servers.school,
            tools: {
              lookup: { ...document().mcp.servers.school.tools.lookup, apiKey: 'test-placeholder' },
            },
          },
        },
      },
    },
    '/mcp/servers/school/tools/lookup/apiKey',
    'invalid',
  ],
] as const)('rejects unsupported versions and extra shape keys at %s', (input, path, code) => {
  expect(() => validate()).not.toThrow();
  rejected(() => validate(input), path, code);
});

test('generates strict fixed-key objects, patterned MCP records and string hook fields', () => {
  const schema = hostConfigJsonSchema();
  let fixedObjects = 0;
  let patterns = 0;
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node['type'] === 'object' && node['properties'] !== undefined) {
      expect(node['additionalProperties']).toBe(false);
      fixedObjects++;
    }
    if (
      node['propertyNames'] !== undefined &&
      JSON.stringify(node['propertyNames']).includes('pattern')
    )
      patterns++;
    if (node['properties'] !== null && typeof node['properties'] === 'object') {
      for (const [key, child] of Object.entries(node['properties'])) {
        expect(['apiKey', 'authorization']).not.toContain(key);
        if (['headers', 'fetch', 'token'].includes(key))
          expect(child).toMatchObject({ type: 'string' });
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(schema);
  expect(fixedObjects).toBeGreaterThan(10);
  expect(patterns).toBe(2);
});

test.each([
  ['Server', 'lookup', 'a'.repeat(64), '/mcp/servers'],
  ['school', 'bad/tool', 'a'.repeat(64), '/mcp/servers/school/tools'],
  ['school', 'lookup', 'pin-marker', '/mcp/servers/school/tools/lookup/pin'],
] as const)('rejects invalid MCP identifiers and pins', (server, tool, pin, path) => {
  expect(() => validate()).not.toThrow();
  const input = document();
  rejected(
    () =>
      validate({
        ...input,
        mcp: {
          servers: {
            [server]: {
              ...input.mcp.servers.school,
              tools: { [tool]: { ...input.mcp.servers.school.tools.lookup, pin } },
            },
          },
        },
      }),
    path,
  );
});

test.each(['token', 'destination'] as const)('requires MCP server %s', (field) => {
  const input = document();
  const server: Record<string, unknown> = { ...input.mcp.servers.school };
  delete server[field];
  expect(() => validate(input)).not.toThrow();
  rejected(
    () => validate({ ...input, mcp: { servers: { school: server } } }),
    `/mcp/servers/school/${field}`,
  );
});

test.each([
  'timeoutMs',
  'concurrency',
  'grantScope',
  'retry',
  'approval',
  'kind',
  'version',
  'pin',
] as const)('requires MCP tool %s', (field) => {
  const input = document();
  const tool: Record<string, unknown> = { ...input.mcp.servers.school.tools.lookup };
  delete tool[field];
  expect(() => validate(input)).not.toThrow();
  rejected(
    () =>
      validate({
        ...input,
        mcp: { servers: { school: { ...input.mcp.servers.school, tools: { lookup: tool } } } },
      }),
    `/mcp/servers/school/tools/lookup/${field}`,
  );
});

test.each([
  ['capabilities', '/capabilities'],
  ['providers', '/models/providers'],
  ['roles', '/models/roles'],
  ['servers', '/mcp/servers'],
] as const)('rejects own prototype keys at %s', (record, path) => {
  const input = document();
  const target =
    record === 'capabilities'
      ? input.capabilities
      : record === 'providers'
        ? input.models.providers
        : record === 'roles'
          ? input.models.roles
          : input.mcp.servers;
  Object.defineProperty(target, '__proto__', { value: {}, enumerable: true, configurable: true });
  const parsed: unknown = JSON.parse(JSON.stringify(input));
  rejected(() => validate(parsed), path);
  Reflect.deleteProperty(target, '__proto__');
  expect(() => validate(input)).not.toThrow();
});

test('cross-checks capabilities, roles and derived MCP tool names with independent controls', () => {
  const input = document();
  const capability = {
    ...input,
    capabilities: { 'unknown@1': input.capabilities['lessons.get@1'] },
  };
  rejected(() => validate(capability), '/capabilities/unknown@1');
  expect(() =>
    validate(capability, {
      ...configDefinition,
      capabilities: {
        optional: { ...configDefinition.capabilities?.optional, 'unknown@1': request },
      },
    }),
  ).not.toThrow();
  const models = { ...input.models, roles: { undeclared: input.models.roles['quiz.generate'] } };
  rejected(() => validate({ ...input, models }), '/models/roles/undeclared');
  expect(() =>
    validate(
      { ...input, models },
      { ...configDefinition, models: { undeclared: { modality: 'text' } } },
    ),
  ).not.toThrow();
  const withoutMcp = {
    ...configDefinition,
    capabilities: { optional: { 'lessons.get@1': request, 'progress.save@1': request } },
  };
  rejected(() => validate(input, withoutMcp), '/mcp/servers/school/tools/lookup');
  expect(() => validate(input)).not.toThrow();
});

test('encodes JSON Pointer slashes and tildes in entry names', () => {
  const input = document();
  rejected(
    () =>
      validate({ ...input, capabilities: { 'missing/~@1': input.capabilities['lessons.get@1'] } }),
    '/capabilities/missing~1~0@1',
  );
  expect(() =>
    validate(
      { ...input, capabilities: { 'missing/~@1': input.capabilities['lessons.get@1'] } },
      {
        ...configDefinition,
        capabilities: {
          optional: { ...configDefinition.capabilities?.optional, 'missing/~@1': request },
        },
      },
    ),
  ).not.toThrow();
});

test.each([
  '//evil.example/x',
  '/\\evil.example',
  '/api/\tlessons',
  '/api/\nlessons',
  'api/x',
  'https://user:pass@evil.example/api',
])('rejects capability URL normalization tricks: %s', (url) => {
  const input = document();
  expect(validate().document.capabilities?.['lessons.get@1']?.url).toBe(
    'https://app.example/api/lessons/{lessonId}',
  );
  rejected(
    () =>
      validate({
        ...input,
        capabilities: { 'lessons.get@1': { ...input.capabilities['lessons.get@1'], url } },
      }),
    '/capabilities/lessons.get@1',
  );
});

test.each([
  'not a URL',
  'https://user:pass@app.example',
  'file:///tmp/document',
  'https://app.\texample',
])('rejects invalid host base URLs at the empty path', (base) => {
  expect(() => validate()).not.toThrow();
  rejected(() => validate(document(), configDefinition, hostHooks(), base), '');
});

test('retains the HTTP factory rejection as cause and applies definition argument annotations', () => {
  const input = document();
  const options = {
    ...input.capabilities['lessons.get@1'],
    url: 'http://evil.example/lessons/{lessonId}',
  };
  const error = rejected(
    () => validate({ ...input, capabilities: { 'lessons.get@1': options } }),
    '/capabilities/lessons.get@1',
  );
  expect(error.cause).toBeInstanceOf(GalaxieError);
  expect(error.cause).toMatchObject({ name: 'GalaxieError', code: 'invalid' });
  expect(() =>
    validate({
      ...input,
      capabilities: { 'lessons.get@1': { ...options, url: 'http://localhost/lessons/{lessonId}' } },
    }),
  ).not.toThrow();
  const freeText = {
    ...configDefinition,
    capabilities: {
      optional: {
        ...configDefinition.capabilities?.optional,
        'lessons.get@1': { ...request, input: z.object({ lessonId: z.string() }) },
      },
    },
  };
  const descriptorError = rejected(() => validate(input, freeText), '/capabilities/lessons.get@1');
  expect(descriptorError.cause).toBeInstanceOf(GalaxieError);
  expect(() => validate(input)).not.toThrow();
});

test.each([
  ['in-browser', 'https://app.example/api/v1', false],
  ['user-device', 'https://app.example/api/v1', false],
  ['third-party', 'http://evil.example/api/v1', false],
  ['host-server', 'https://user:pass@app.example/api/v1', false],
  ['host-server', 'https://app.example/api/v1?marker=1', false],
  ['host-server', 'https://app.example/api/v1#marker', false],
  ['user-device', 'http://localhost/api/v1', true],
  ['host-server', 'https://app.example/api/v1', true],
] as const)(
  'enforces endpoint destination and constructor restrictions (%s, %s)',
  (destination, baseURL, accepted) => {
    const input = document();
    const value = {
      ...input,
      models: {
        ...input.models,
        providers: {
          ...input.models.providers,
          quiz: {
            ...input.models.providers.quiz,
            destination,
            endpoint: { ...input.models.providers.quiz.endpoint, baseURL },
          },
        },
      },
    };
    expect(() => validate()).not.toThrow();
    if (accepted) expect(() => validate(value)).not.toThrow();
    else rejected(() => validate(value), '/models/providers/quiz');
  },
);

test.each(['headers', 'fetch'] as const)('resolves own capability %s hooks only', (group) => {
  const input = document();
  const original = input.capabilities['lessons.get@1'][group];
  for (const name of ['missing-hook-marker', 'constructor', '__proto__']) {
    rejected(
      () =>
        validate({
          ...input,
          capabilities: {
            'lessons.get@1': { ...input.capabilities['lessons.get@1'], [group]: name },
          },
        }),
      `/capabilities/lessons.get@1/${group}`,
    );
  }
  expect(() => validate(input)).not.toThrow();
  const hooks = hostHooks();
  const inheritedName = {
    ...hooks,
    [group]: Object.create({
      [original]: hooks[group][original as keyof (typeof hooks)[typeof group]],
    }),
  };
  rejected(
    () => validate(input, configDefinition, inheritedName),
    `/capabilities/lessons.get@1/${group}`,
  );
  const inheritedGroup: HostConfigHooks = Object.create(hooks);
  rejected(
    () => validate(input, configDefinition, inheritedGroup),
    '/capabilities/lessons.get@1/headers',
  );
  const { [group]: functions, ...ownGroups } = hooks;
  rejected(
    () =>
      validate(
        input,
        configDefinition,
        Object.assign(Object.create({ [group]: functions }), ownGroups),
      ),
    `/capabilities/lessons.get@1/${group}`,
  );
});

test.each(['getCredential', 'consent', 'availability', 'download'] as const)(
  'resolves named model %s hooks without inheritance',
  (group) => {
    const input = document();
    for (const name of ['missing-hook-marker', 'constructor', '__proto__'])
      rejected(
        () => validate({ ...input, models: { ...input.models, [group]: name } }),
        `/models/${group}`,
      );
    expect(() => validate(input)).not.toThrow();
    const hooks = hostHooks();
    rejected(
      () => validate(input, configDefinition, { ...hooks, [group]: Object.create(hooks[group]) }),
      `/models/${group}`,
    );
    const { [group]: functions, ...ownGroups } = hooks;
    rejected(
      () =>
        validate(
          input,
          configDefinition,
          Object.assign(Object.create({ [group]: functions }), ownGroups),
        ),
      `/models/${group}`,
    );
  },
);

test.each(['token', 'fetch'] as const)(
  'resolves named MCP %s hooks without inheritance',
  (group) => {
    const input = document();
    for (const name of ['missing-hook-marker', 'constructor', '__proto__'])
      rejected(
        () =>
          validate({
            ...input,
            mcp: { servers: { school: { ...input.mcp.servers.school, [group]: name } } },
          }),
        `/mcp/servers/school/${group}`,
      );
    expect(() => validate(input)).not.toThrow();
    if (group === 'token') {
      const hooks = hostHooks();
      rejected(
        () => validate(input, configDefinition, { ...hooks, token: Object.create(hooks.token) }),
        '/mcp/servers/school/token',
      );
      const { token, ...ownGroups } = hooks;
      rejected(
        () => validate(input, configDefinition, Object.assign(Object.create({ token }), ownGroups)),
        '/mcp/servers/school/token',
      );
    }
  },
);

test('resolves endpoint fetch hooks through the named record', () => {
  const input = document();
  rejected(
    () =>
      validate({
        ...input,
        models: {
          ...input.models,
          providers: {
            ...input.models.providers,
            quiz: {
              ...input.models.providers.quiz,
              endpoint: { ...input.models.providers.quiz.endpoint, fetch: 'missing-hook-marker' },
            },
          },
        },
      }),
    '/models/providers/quiz/endpoint/fetch',
  );
  expect(() => validate(input)).not.toThrow();
});

test.each(['constructor', 'toString', '__proto__'])(
  'rejects inherited role and provider names: %s',
  (name) => {
    const input = document();
    const roles = { [name]: input.models.roles['quiz.generate'] };
    rejected(
      () => validate({ ...input, models: { ...input.models, roles } }),
      name === '__proto__' ? '/models/roles' : `/models/roles/${name}`,
    );
    const providers = [name];
    rejected(
      () =>
        validate({
          ...input,
          models: {
            ...input.models,
            roles: { 'quiz.generate': { ...input.models.roles['quiz.generate'], providers } },
          },
        }),
      '/models/roles/quiz.generate/providers/0',
    );
    expect(() => validate(input)).not.toThrow();
  },
);

test.each(['http://evil.example/mcp', 'https://user:pass@app.example/mcp'])(
  'rejects invalid MCP URLs: %s',
  (url) => {
    const input = document();
    rejected(
      () =>
        validate({ ...input, mcp: { servers: { school: { ...input.mcp.servers.school, url } } } }),
      '/mcp/servers/school',
    );
    expect(() =>
      validate({
        ...input,
        mcp: { servers: { school: { ...input.mcp.servers.school, url: 'http://localhost/mcp' } } },
      }),
    ).not.toThrow();
  },
);

test('requires explicit confirmation on MCP writes', () => {
  const input = document();
  const tool = { ...input.mcp.servers.school.tools.lookup, kind: 'write' };
  const withTool = (approval: string) => ({
    ...input,
    mcp: {
      servers: {
        school: { ...input.mcp.servers.school, tools: { lookup: { ...tool, approval } } },
      },
    },
  });
  rejected(() => validate(withTool('none')), '/mcp/servers/school/tools/lookup');
  expect(() => validate(withTool('confirm'))).not.toThrow();
});

test('builds GET and POST policies identical to independent hand-built bindings', () => {
  const hooks = hostHooks();
  const built = buildHostConfig(validate(document(), configDefinition, hooks));
  const expected = {
    'lessons.get@1': httpCapability({
      ...policy,
      kind: 'read',
      approval: 'none',
      method: 'GET',
      url: 'https://app.example/api/lessons/{lessonId}',
      headers: hooks.headers.session,
      fetch: hooks.fetch.transport,
    }),
    'progress.save@1': httpCapability({
      ...policy,
      kind: 'write',
      approval: 'confirm',
      method: 'POST',
      url: 'https://app.example/api/progress',
      headers: hooks.headers.session,
      fetch: hooks.fetch.transport,
    }),
  };
  for (const [name, handBuilt] of Object.entries(expected)) {
    const actual = built.bindings[name];
    expect(actual).toBeDefined();
    const { invoke: _invoke, ...expectedPolicy } = handBuilt;
    expect(actual).toMatchObject(expectedPolicy);
    if (actual !== undefined) expect(getHttpCapability(actual)).toBeDefined();
  }
});

test('builds literal host-remote routing, endpoint options and host hook identities', () => {
  const input = document();
  const hooks = hostHooks();
  const built = buildHostConfig(validate(input, configDefinition, hooks));
  expect(built.modelRouting).toEqual({
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
    consent: hooks.consent.notice,
    getCredential: hooks.getCredential.session,
    availability: hooks.availability.ready,
    download: hooks.download.prepare,
  });
  expect(built.modelRouting.consent).toBe(hooks.consent.notice);
  expect(built.modelRouting.getCredential).toBe(hooks.getCredential.session);
  expect(built.endpoints).toEqual({
    quiz: {
      baseURL: 'https://app.example/api/v1',
      model: 'host-quiz',
      destination: 'host-server',
      fetch: hooks.fetch.transport,
    },
  });
  const endpoint = { ...input.models.providers.quiz.endpoint, maxTokens: 128, temperature: 0.2 };
  const withLimits = {
    ...input,
    models: {
      ...input.models,
      providers: { ...input.models.providers, quiz: { ...input.models.providers.quiz, endpoint } },
    },
  };
  expect(
    buildHostConfig(validate(withLimits, configDefinition, hooks)).endpoints['quiz'],
  ).toMatchObject({ maxTokens: 128, temperature: 0.2 });
  expect(built.endpoints['quiz']).not.toHaveProperty('maxTokens');
  expect(built.endpoints['quiz']).not.toHaveProperty('temperature');
});

test('builds unchanged runtime limits and enforces the documented tool-call budget', async () => {
  const input = document();
  const limits = buildRuntimeLimits(validate(input));
  expect(limits).toEqual({
    budgets: {
      steps: 3,
      tokens: 4000,
      cost: 0,
      repairAttempts: 1,
      toolCalls: 2,
      wallClockMs: 1000,
      payloadBytes: 4096,
      uiElements: 5,
    },
    dataPolicy: {
      public: { allow: ['in-browser', 'host-server'] },
      app: { allow: ['host-server'] },
      'private-user': { allow: ['in-browser'] },
    },
    urlAllowlist: ['https://app.example'],
  });
  const outcomes: unknown[] = [];
  const executor = new FakeExecutor([
    async function* ({ capabilities }) {
      for (let i = 0; i < 3; i++) {
        try {
          outcomes.push(await capabilities.call('echo@1', {}));
        } catch (error) {
          outcomes.push(error);
        }
      }
      yield { type: 'output', output: null };
    },
  ]);
  const runtime = createRuntime({ appId: 'config-tests', executors: [executor], ...limits });
  const instance = await runtime.create(
    {
      ...definition,
      input: z.object({}),
      capabilities: {
        optional: { 'echo@1': { input: z.object({}), output: z.unknown(), kind: 'read' } },
      },
    },
    {
      principalScope: 'user',
      agent: {},
      bindings: { 'echo@1': binding({ destination: 'host-server' }) },
    },
  );
  await instance.prepare();
  const { runId } = await instance.start({});
  const events = await collect(instance.events(runId));
  expect(outcomes.slice(0, 2)).toEqual([{}, {}]);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'budget_exceeded' }),
    }),
  );
  await runtime.dispose();
  expect(buildRuntimeLimits(validate({ version: '0.1' }))).toEqual({});
});

test('merges code bindings, rejects duplicates and rejects forged validated objects', () => {
  const validated = validate();
  const codeBinding = binding();
  expect(buildHostConfig(validated, { 'code@1': codeBinding }).bindings['code@1']).toBe(
    codeBinding,
  );
  rejected(
    () => buildHostConfig(validated, { 'lessons.get@1': codeBinding }),
    '/capabilities/lessons.get@1',
  );
  const forged = { document: validated.document, hooks: validated.hooks };
  rejected(() => buildHostConfig(forged), '');
  rejected(() => buildRuntimeLimits(forged), '');
});

test('isolates later builds from document, validated-tree and prior output mutations', () => {
  const input = document();
  const validated = validate(input);
  const built = buildHostConfig(validated);
  input.models.roles['quiz.generate'].providers.push('feedback');
  input.capabilities['lessons.get@1'].url = 'https://evil.example';
  expect(() => Reflect.set(validated.document, 'version', '9.9')).not.toThrow();
  expect(validated.document.version).toBe('0.1');
  const role = built.modelRouting.roles['quiz.generate'];
  const provider = built.modelRouting.providers['quiz'];
  if (role === undefined || provider === undefined) throw new Error('Missing model wiring.');
  (role.providers as string[]).push('feedback');
  (provider.features as string[]).push('tool-calling');
  const next = buildHostConfig(validated);
  expect(next.modelRouting.roles['quiz.generate']?.providers).toEqual(['quiz']);
  expect(next.modelRouting.providers['quiz']?.features).toEqual([
    'streaming',
    'cancellation',
    'structured-output',
  ]);
  expect(next.endpoints['quiz']?.baseURL).toBe('https://app.example/api/v1');
});

test.each([
  ['steps', 0],
  ['steps', 1.5],
  ['tokens', Infinity],
  ['cost', -1],
  ['repairAttempts', -1],
  ['toolCalls', 0.5],
  ['wallClockMs', -1],
  ['payloadBytes', NaN],
  ['uiElements', 0.1],
] as const)(
  'rejects invalid runtime budget %s without changing the runtime gate',
  (name, value) => {
    const input = document();
    rejected(
      () =>
        validate({
          ...input,
          limits: { ...input.limits, budgets: { ...input.limits.budgets, [name]: value } },
        }),
      `/limits/budgets/${name}`,
    );
    expect(() => validate(input)).not.toThrow();
  },
);

test('accepts zero runtime limits where the runtime accepts them and rejects malformed URL allowlists', async () => {
  const input = document();
  const zeroLimits = {
    steps: 1,
    tokens: 0,
    cost: 0,
    repairAttempts: 0,
    toolCalls: 0,
    wallClockMs: 0,
    payloadBytes: 0,
    uiElements: 0,
  };
  const limits = buildRuntimeLimits(
    validate({ ...input, limits: { ...input.limits, budgets: zeroLimits } }),
  );
  expect(limits.budgets).toEqual(zeroLimits);
  const runtime = createRuntime({ appId: 'config-zero-tests', executors: [], ...limits });
  await runtime.dispose();
  for (const origin of [
    'https://app.example/path',
    'http://evil.example',
    'https://user:pass@app.example',
  ])
    rejected(
      () => validate({ ...input, limits: { ...input.limits, urlAllowlist: [origin] } }),
      '/limits/urlAllowlist',
    );
  expect(() => validate(input)).not.toThrow();
});

test('validates an empty wiring document and emits the literal schema version', () => {
  const result = validateHostConfig(
    { version: '0.1' },
    { id: 'tests/config', version: '1.0.0', executor: 'fake', input: z.string() },
    {},
    'https://app.example',
  );
  expect(result.document).toEqual({ version: '0.1' });
  expect(hostConfigJsonSchema()).toMatchObject({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: { version: { const: '0.1' } },
  });
});
