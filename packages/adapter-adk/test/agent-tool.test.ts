// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { AgentTool, type BaseAgent, createEvent, LlmAgent, Workflow } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, brokerFixture, collect } from '../../core/test/fake-executor.js';
import { createAdkAdapter } from '../src/adapter.js';
import { admitCapabilities, agentTool, innerPause } from '../src/agent-tool.js';
import { type AdkHost, createHost } from '../src/host.js';
import { FakeChatModel } from './support/fixtures.js';

test.each([
  ['read', 'none', true],
  ['write', 'confirm', false],
  ['write', 'none', false],
  ['read', 'confirm', false],
  ['missing', 'none', false],
] as const)('admission uses authoritative %s/%s policy', async (kind, approval, allowed) => {
  const fixture = await brokerFixture({
    requests: {
      'read@1': {
        kind: kind === 'write' ? 'write' : 'read',
        input: z.object({}),
        output: z.string(),
      },
    },
    bindings: kind === 'missing' ? {} : { 'read@1': binding({ kind, approval }) },
    scripts: [
      async function* ({ capabilities }) {
        if (allowed) expect(() => admitCapabilities(['read@1'], capabilities)).not.toThrow();
        else
          expect(() => admitCapabilities(['read@1'], capabilities)).toThrowError(
            expect.objectContaining({ code: 'unsupported' }),
          );
        yield { type: 'output', output: null };
      },
    ],
  });
  try {
    const run = await fixture.instance.start('public');
    await collect(fixture.instance.events(run.runId));
    expect(fixture.scriptErrors).toEqual([]);
  } finally {
    await fixture.runtime.dispose();
  }
});

const preparation = { roles: ['agent'], providers: { mock: { credential: false } } };
const spec = { description: 'Read.', parameters: z.object({}) };

test('package helper preserves the host inventory and refuses foreign hosts', () => {
  const { host, registry } = createHost(
    { chatModels: {} },
    undefined,
    () => undefined,
    () => 's',
  );
  expect(Object.keys(host).sort()).toEqual(['adk', 'capabilities']);
  expect(Object.keys(host.adk).sort()).toEqual(['capabilityTool', 'llm', 'requestInput']);
  const inner = new LlmAgent({ name: 'inner' });
  const tool = agentTool(host, inner);
  expect(registry.tools.has(tool)).toBe(true);
  expect(registry.wrappers.get(tool)).toBe(inner);
  expect(() => agentTool({} as AdkHost, inner)).toThrowError(
    expect.objectContaining({ code: 'invalid' }),
  );
});

test.each([
  'confirmation',
  'long-running',
  'request-input',
  'nested',
  'input-schema',
  'output-schema',
  'workflow',
  'subclass',
  'missing-model',
  'repeated-name',
  'tool-collision',
  'raw',
])('prepare refuses inner %s before a model request', async (shape) => {
  const model = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  await expect(
    createAdkAdapter().prepare(
      (host) => {
        let inner = new LlmAgent({ name: 'inner', model: host.adk.llm('agent') });
        if (shape === 'confirmation')
          inner.tools.push(
            host.adk.capabilityTool('read@1', { ...spec, requireConfirmation: true }),
          );
        if (shape === 'long-running')
          inner.tools.push(host.adk.capabilityTool('read@1', { ...spec, longRunning: true }));
        if (shape === 'request-input') inner.tools.push(host.adk.requestInput());
        if (shape === 'nested')
          inner.tools.push(
            agentTool(host, new LlmAgent({ name: 'nested', model: host.adk.llm('agent') })),
          );
        if (shape === 'input-schema')
          Reflect.set(inner, 'inputSchema', z.object({ request: z.string() }));
        if (shape === 'output-schema')
          Reflect.set(inner, 'outputSchema', z.object({ answer: z.string() }));
        if (shape === 'workflow')
          return new LlmAgent({
            name: 'outer',
            model: host.adk.llm('agent'),
            tools: [
              agentTool(
                host,
                new Workflow({
                  name: 'workflow',
                  dynamicEntry: () => undefined,
                }) as unknown as BaseAgent,
              ),
            ],
          });
        if (shape === 'subclass') {
          class Foreign extends LlmAgent {}
          inner = new Foreign({ name: 'inner', model: host.adk.llm('agent') });
        }
        if (shape === 'missing-model') inner = new LlmAgent({ name: 'inner' });
        if (shape === 'repeated-name') Reflect.set(inner, 'name', 'outer');
        const tool = shape === 'raw' ? new AgentTool({ agent: inner }) : agentTool(host, inner);
        return new LlmAgent({
          name: 'outer',
          model: host.adk.llm('agent'),
          tools: [
            tool,
            ...(shape === 'tool-collision'
              ? [host.adk.capabilityTool('read@1', { ...spec, toolName: 'inner' })]
              : []),
          ],
        });
      },
      { chatModels: { mock: model } },
      { signal: new AbortController().signal, models: preparation },
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(model.seen).toEqual([]);
});

test('inner pause backstop recognizes confirmation and long-running markers', () => {
  expect(innerPause(createEvent({ author: 'inner' }))).toBe(false);
  expect(innerPause(createEvent({ author: 'inner', longRunningToolIds: ['x'] }))).toBe(true);
  expect(
    innerPause(
      createEvent({
        author: 'inner',
        actions: { requestedToolConfirmations: { x: { confirmed: false, hint: '' } } },
      }),
    ),
  ).toBe(true);
});
