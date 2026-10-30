// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createRuntime,
  type DataPolicy,
  type DevelopmentWarning,
  type DiagnosticEvent,
  galaxieField,
  type InteractionId,
  type PendingInteraction,
} from '../src/index.js';
import { collect, definition, FakeExecutor } from './fake-executor.js';
import { MemoryRecoveryStore } from './support/memory-recovery-store.js';

const sentence = 'My private sentence stays here';
const origin = 'https://example.test';
const encoded = encodeURIComponent(sentence);
const controlledQueries = ['\t', '\n', '\r'].map((control) =>
  encoded.replace('private', `pri${control}vate`),
);
const urls = [
  `${origin}/search?q=${sentence}`,
  `${origin}/search?q=${encoded}`,
  `${origin}/search?q=${encoded.replaceAll('%20', '+')}`,
  `${origin}/search?q=${encodeURIComponent(encoded)}`,
  `${origin}/${sentence}`,
  `${origin}/${encoded}`,
  `${origin}/${encodeURIComponent(encoded)}`,
  `${origin}/search?q=${sentence}&malformed=%ZZ`,
  `${origin}/search?q=${encoded}&malformed=%ZZ`,
  `${origin}/search?q=${encodeURIComponent(encoded)}&malformed=%ZZ`,
  `${origin}/search?q=${encoded.replaceAll('%20', '+')}&malformed=%ZZ`,
  `${origin}/search?q=${encoded}&malformed=%80`,
  ...controlledQueries.flatMap((value) => [`${origin}/search?q=${value}`, `${origin}/${value}`]),
];

async function fixture(url: string, dataPolicy?: DataPolicy) {
  const pending: PendingInteraction = {
    interactionId: 'private-url' as InteractionId,
    surfaceId: 'main',
    viewRevision: 'v1' as PendingInteraction['viewRevision'],
    component: 'tests.Link/v1',
    props: { nested: [{ url }] },
  };
  const executor = new FakeExecutor([[{ type: 'interaction', interaction: pending }]]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => pending;
  const warnings: DevelopmentWarning[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const runtime = createRuntime({
    appId: 'private-interaction',
    executors: [executor],
    urlAllowlist: [origin],
    developmentWarnings: (warning) => warnings.push(warning),
    diagnostics: (event) => diagnostics.push(event),
    ...(dataPolicy === undefined ? {} : { dataPolicy }),
  });
  const store = new MemoryRecoveryStore();
  const privateDefinition = {
    ...definition,
    input: z.string().meta(galaxieField({ label: 'private-user' })),
  };
  const instance = await runtime.create(privateDefinition, {
    principalScope: 'learner',
    agent: {},
    recovery: store,
  });
  await instance.prepare();
  return { runtime, instance, store, privateDefinition, warnings, diagnostics };
}

test.each(urls)('registered private text in a URL is denied: %s', async (url) => {
  const f = await fixture(url);
  try {
    const { runId } = await f.instance.start(sentence);
    await expect.poll(() => f.instance.getSnapshot().run?.status).toBe('failed');
    const events = await collect(f.instance.events(runId));
    expect(f.instance.getSnapshot().run).toMatchObject({
      status: 'failed',
      error: { code: 'denied', message: 'Policy denied the request.' },
    });
    expect(f.instance.getSnapshot().run?.pending).toBeUndefined();
    expect(events.some((event) => event.type === 'interaction')).toBe(false);
    expect(f.diagnostics).toEqual([
      { kind: 'interaction_rejected', instanceId: f.instance.instanceId, runId },
    ]);
    expect(f.warnings).toContainEqual({ code: 'url_blocked', instanceId: f.instance.instanceId });
    const exposed = JSON.stringify([events, f.instance.getSnapshot(), f.diagnostics, f.warnings]);
    expect(exposed).not.toContain(sentence);
    expect(exposed).not.toContain(origin);
  } finally {
    await f.runtime.dispose();
  }
});

test.each([
  ['unregistered value', `${origin}/search?q=unregistered-value`, undefined],
  ['malformed escape', `${origin}/search?q=public+value&malformed=%ZZ`, undefined],
  ['invalid UTF-8 run', `${origin}/search?q=public+value&malformed=%80`, undefined],
  ['third-party permission', urls[3] as string, { 'private-user': { allow: ['third-party'] } }],
] as const)('an allowlisted URL passes with %s', async (_name, url, policy) => {
  const f = await fixture(url, policy);
  try {
    const { runId } = await f.instance.start(sentence);
    await expect.poll(() => f.instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(f.instance.getSnapshot().run?.pending?.props).toEqual({ nested: [{ url }] });
    expect(f.diagnostics).toEqual([]);
    await f.instance.cancel(runId);
  } finally {
    await f.runtime.dispose();
  }
});

test.each([urls[3] as string, ...controlledQueries.map((value) => `${origin}/search?q=${value}`)])(
  'restored pending URLs are checked against recovered submission strings: %s',
  async (url) => {
    const f = await fixture(url);
    try {
      const sessionId = f.instance.sessionId;
      await f.store.recordSession(sessionId, {
        agentId: f.privateDefinition.id,
        agentVersion: f.privateDefinition.version,
        executorId: 'fake',
      });
      const interactionId = 'previous-writing' as InteractionId;
      await f.store.acceptSubmission(sessionId, {
        interactionId,
        action: 'submit',
        payload: { sentence },
      });
      await f.store.consumeSubmission(sessionId, interactionId);
      const restored = await f.runtime.create(f.privateDefinition, {
        principalScope: 'learner',
        agent: {},
        recovery: f.store,
        sessionId,
      });
      await restored.prepare();
      await expect(restored.restore()).rejects.toMatchObject({
        code: 'denied',
        message: 'Policy denied the request.',
      });
      expect(restored.getSnapshot().run).toBeUndefined();
      expect(f.diagnostics).toContainEqual({
        kind: 'interaction_rejected',
        instanceId: restored.instanceId,
      });
      expect(f.warnings).toContainEqual({ code: 'url_blocked', instanceId: restored.instanceId });
      expect(JSON.stringify([restored.getSnapshot(), f.diagnostics, f.warnings])).not.toContain(
        origin,
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);
