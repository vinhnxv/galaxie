// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createLangGraphAdapter,
  type LangGraphGraph,
  requestInteraction,
} from '@galaxie/adapter-langgraph';
import {
  type AgentSnapshot,
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  type InteractionId,
  type PendingInteraction,
  type ViewRevision,
} from '@galaxie/core';
import {
  Annotation,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  collect,
  definition,
  FakeExecutor,
  flush,
} from '../../packages/core/test/fake-executor.js';

const interaction: PendingInteraction = {
  interactionId: 'url-policy' as InteractionId,
  surfaceId: 'main',
  viewRevision: 'r1' as ViewRevision,
  component: 'tests.Question/v1',
  props: {},
};

async function runInteraction(
  props: unknown,
  options: { urlAllowlist?: readonly string[]; interrupts?: boolean } = {},
) {
  const pending = { ...interaction, props };
  const executor = new FakeExecutor([[{ type: 'interaction', interaction: pending }]]);
  Object.assign(executor.features, { interrupts: options.interrupts ?? true });
  const diagnostics: DiagnosticEvent[] = [];
  const snapshots: AgentSnapshot<unknown>[] = [];
  const runtime = createRuntime({
    appId: 'interaction-policy',
    executors: [executor],
    ...(options.urlAllowlist === undefined ? {} : { urlAllowlist: options.urlAllowlist }),
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(definition, { principalScope: 'fixture', agent: {} });
  instance.subscribe(() => snapshots.push(instance.getSnapshot()));
  try {
    await instance.prepare();
    const { runId } = await instance.start('input');
    await flush();
    const snapshot = instance.getSnapshot();
    await instance.cancel(runId);
    const events = await collect(instance.events(runId));
    await runtime.dispose();
    return { pending, snapshot, snapshots, diagnostics, events };
  } finally {
    await runtime.dispose();
  }
}

test('an allowlisted URL and plain Note text become pending', async () => {
  const result = await runInteraction(
    { image: 'https://cdn.example.com/a.png', note: 'Note: see page 3' },
    { urlAllowlist: ['https://cdn.example.com'] },
  );
  expect(result.snapshot.run?.status).toBe('waiting_input');
  expect(result.snapshot.run?.pending).toEqual(result.pending);
  expect(result.events.filter((event) => event.type === 'interaction')).toHaveLength(1);
  expect(result.diagnostics).toEqual([]);
});

test('the default empty allowlist permits interactions containing only plain text', async () => {
  const result = await runInteraction({
    note: 'Note: see page 3',
    nested: ['10:30', { email: 'mailto:a@b.c' }],
  });
  expect(result.snapshot.run?.pending).toEqual(result.pending);
  expect(result.diagnostics).toEqual([]);
});

test.each([
  'https://cdn.example.com:8443',
  'http://localhost:9000',
  'http://127.0.0.1',
  'http://[::1]:8000',
])('allowlisted exact ports and loopback HTTP pause normally: %s', async (origin) => {
  const result = await runInteraction(
    { nested: [{ image: `${origin}/a.png` }] },
    { urlAllowlist: [origin] },
  );
  expect(result.snapshot.run?.status).toBe('waiting_input');
  expect(result.snapshot.run?.pending).toEqual(result.pending);
});

test.each([
  'https://cdn.example.com/path',
  'https://cdn.example.com?',
  'https://user:pass@cdn.example.com',
  'http://cdn.example.com',
])('runtime rejects invalid URL allowlist entries: %s', (origin) => {
  expect(() =>
    createRuntime({ appId: 'invalid-origins', executors: [], urlAllowlist: [origin] }),
  ).toThrowError(
    expect.objectContaining({ code: 'invalid', message: 'The URL allowlist is invalid.' }),
  );
});

const rejectedUrls = [
  'https://evil.example/?d=url-canary',
  'javascript:alert(1)',
  ' java\tscript:alert(1)',
  '//evil.example/x',
  '\\\\evil.example/x',
  '/\\evil.example/x',
  '\\/evil.example/x',
  'https:evil.example',
  'http:evil.example/x',
  'wss:evil.example',
  'ftp:evil.example',
  'data:text/html,x',
  'BlOb:https://cdn.example.com/id',
  'FiLe:///etc/file',
  'https://user:pass@cdn.example.com/x',
  'https://cdn.example.com:8443/x',
];
test.each(rejectedUrls)('rejected URL candidate never becomes host-visible: %s', async (url) => {
  const result = await runInteraction(
    { nested: [{ value: url, privateProp: 'interaction-prop-canary' }] },
    { urlAllowlist: ['https://cdn.example.com'] },
  );
  expect(result.snapshot.run).toMatchObject({
    status: 'failed',
    error: { code: 'denied', message: 'Policy denied the request.' },
  });
  expect(result.snapshot.run?.pending).toBeUndefined();
  expect(result.events.filter((event) => event.type === 'interaction')).toHaveLength(0);
  expect(result.events.filter((event) => event.type === 'error')).toHaveLength(1);
  expect(result.diagnostics).toEqual([
    {
      kind: 'interaction_rejected',
      instanceId: result.snapshot.instanceId,
      runId: result.snapshot.run?.runId,
    },
  ]);
  const exposed = JSON.stringify({
    snapshots: result.snapshots,
    snapshot: result.snapshot,
    diagnostics: result.diagnostics,
    events: result.events.filter((event) => event.type !== 'stream'),
  });
  expect(exposed).not.toContain(url);
  expect(exposed).not.toMatch(
    /evil\.example|alert\(1\)|text\/html|interaction-prop-canary|user:pass|cdn\.example/,
  );
});

test('the default empty allowlist rejects URL candidates', async () => {
  const result = await runInteraction({ image: 'https://cdn.example.com/a.png' });
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect(result.snapshot.run?.pending).toBeUndefined();
});

test('a failed props inspection is denied without publishing the thrown prop value', async () => {
  const props = {
    get image(): never {
      throw new Error('https://evil.example/getter-prop-canary');
    },
  };
  const result = await runInteraction(props);
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: { code: 'denied' } });
  expect(result.diagnostics.map((event) => event.kind)).toEqual(['interaction_rejected']);
  expect(
    JSON.stringify({
      snapshots: result.snapshots,
      diagnostics: result.diagnostics,
      events: result.events,
    }),
  ).not.toMatch(/evil\.example|getter-prop-canary/);
});

test('executor interrupt feature honesty is checked before URL policy', async () => {
  const result = await runInteraction({ url: 'https://evil.example/x' }, { interrupts: false });
  expect(result.snapshot.run).toMatchObject({
    status: 'failed',
    error: { code: 'executor_error', type: 'ProtocolViolation' },
  });
  expect(result.snapshot.run?.pending).toBeUndefined();
  expect(result.diagnostics.map((event) => event.kind)).toEqual(['protocol_violation']);
  expect(result.events.filter((event) => event.type === 'error')).toHaveLength(1);
  expect(
    JSON.stringify({
      snapshots: result.snapshots,
      diagnostics: result.diagnostics,
      events: result.events,
    }),
  ).not.toContain('evil.example');
});

test('allowlist origins are normalized and copied at runtime creation', async () => {
  const urlAllowlist = ['https://CDN.example.com:443/'];
  const executor = new FakeExecutor([
    [
      {
        type: 'interaction',
        interaction: { ...interaction, props: { image: 'https://cdn.example.com/a.png' } },
      },
    ],
  ]);
  const runtime = createRuntime({ appId: 'origins', executors: [executor], urlAllowlist });
  urlAllowlist[0] = 'https://evil.example';
  const instance = await runtime.create(definition, { principalScope: 'fixture', agent: {} });
  try {
    await instance.prepare();
    await instance.start('input');
    await flush();
    expect(instance.getSnapshot().run?.status).toBe('waiting_input');
  } finally {
    await runtime.dispose();
  }
});

test('real graph rejects pending URLs while raw updates and committed checkpoint retain the interrupt', async () => {
  const url = 'https://evil.example/real-graph-canary';
  const request = {
    surfaceId: 'main',
    viewRevision: 'r1',
    component: 'tests.Question/v1' as const,
    props: { image: url, note: 'interaction-prop-canary' },
  };
  const diagnostics: DiagnosticEvent[] = [];
  const snapshots: AgentSnapshot<unknown>[] = [];
  let graph: LangGraphGraph | undefined;
  let checkpointConfig: LangGraphRunnableConfig | undefined;
  const runtime = createRuntime({
    appId: 'real-url-policy',
    executors: [createLangGraphAdapter()],
    diagnostics: (event) => diagnostics.push(event),
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/interaction-policy',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ value: z.number() }),
    }),
    {
      principalScope: 'fixture',
      agent: (host) => {
        const state = Annotation.Root({ value: Annotation<number> });
        graph = new StateGraph(state)
          .addNode('ask', async (_state, config) => {
            checkpointConfig = config;
            await Promise.resolve();
            requestInteraction(request, config);
            return {};
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() });
        return graph;
      },
    },
  );
  instance.subscribe(() => snapshots.push(instance.getSnapshot()));
  try {
    await instance.prepare();
    const { runId } = await instance.start({ value: 1 });
    const events = await collect(instance.events(runId));
    expect(instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'denied' },
    });
    expect(instance.getSnapshot().run?.pending).toBeUndefined();
    expect(events.some((event) => event.type === 'interaction')).toBe(false);
    const exposed = JSON.stringify({
      snapshots,
      diagnostics,
      events: events.filter((event) => event.type !== 'stream'),
    });
    expect(exposed).not.toMatch(/evil\.example|real-graph-canary|interaction-prop-canary/);
    expect(
      events.some(
        (event) =>
          event.type === 'stream' &&
          event.mode === 'updates' &&
          event.path.length === 0 &&
          JSON.stringify(event.data).includes(url),
      ),
    ).toBe(true);
    await runtime.dispose();
    if (graph === undefined || checkpointConfig === undefined)
      throw new Error('The checkpoint fixture was not initialized.');
    const checkpoint = await graph.getState({
      configurable: { thread_id: checkpointConfig.configurable?.['thread_id'] },
    });
    expect(checkpoint.tasks.flatMap((task) => task.interrupts)).toMatchObject([{ value: request }]);
  } finally {
    await runtime.dispose();
  }
});
