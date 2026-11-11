// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { capabilityBindingPolicy } from '@galaxie-ai/core';
import { AgentTool, LlmAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { binding, brokerFixture, collect } from '../../core/test/fake-executor.js';
import { createAdkAdapter } from '../src/adapter.js';
import { createHost } from '../src/host.js';
import { validateAgentTree } from '../src/validate.js';
import { FakeChatModel } from './support/fixtures.js';

// The removed prototype and its measurements are preserved in commit 83c814e.
// ADR-0020 records the failed read-only admission gate and the unmeasured gates.
// These characterizations retain the refusal evidence without shipping a wrapper.
const preparation = { roles: ['agent'], providers: { mock: { credential: false } } };
const writeSpec = { description: 'Save.', parameters: z.object({ value: z.string() }) };

test('a host tool does not acquire an ADK confirmation flag from its capability name', async () => {
  const model = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  const { host, registry } = createHost(
    { chatModels: { mock: model } },
    preparation,
    () => undefined,
    () => 'conversation',
  );
  const tool = host.adk.capabilityTool('save@1', writeSpec);
  const inner = new LlmAgent({ name: 'worker', model: host.adk.llm('agent'), tools: [tool] });
  // No run port or host binding policy is available at this point. A pause registry
  // populated only from optional tool flags cannot prove this tree is read-only.
  expect(await tool.checkRequireConfirmation({ value: 'x' })).toBe(false);
  expect(tool.isLongRunning).toBe(false);
  expect(() => validateAgentTree(inner, registry)).not.toThrow();
  const flagged = host.adk.capabilityTool('save@1', { ...writeSpec, requireConfirmation: true });
  expect(await flagged.checkRequireConfirmation({ value: 'x' })).toBe(true);
  expect(model.seen).toHaveLength(0);
});

test('the real run port classifies a write and the broker refuses missing confirmation coverage', async () => {
  let writes = 0;
  const fixture = await brokerFixture({
    requests: { 'save@1': { kind: 'write', input: writeSpec.parameters, output: z.string() } },
    bindings: {
      'save@1': binding({
        kind: 'write',
        approval: 'confirm',
        invoke: async () => {
          writes += 1;
          return 'saved';
        },
      }),
    },
    scripts: [
      async function* ({ capabilities }) {
        expect(capabilityBindingPolicy(capabilities, 'save@1')).toEqual({
          kind: 'write',
          approval: 'confirm',
          confirmationAvailable: false,
        });
        await expect(capabilities.call('save@1', { value: 'x' })).rejects.toMatchObject({
          code: 'unsupported',
        });
        yield { type: 'output', output: null };
      },
    ],
  });
  try {
    const run = await fixture.instance.start('public input');
    await collect(fixture.instance.events(run.runId));
    expect(fixture.scriptErrors).toEqual([]);
    expect(writes).toBe(0);
  } finally {
    await fixture.runtime.dispose();
  }
});

test('raw AgentTool stays refused by the shipped adapter before any model call', async () => {
  const model = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
  await expect(
    createAdkAdapter().prepare(
      (host) => {
        const inner = new LlmAgent({
          name: 'worker',
          model: host.adk.llm('agent'),
          tools: [host.adk.capabilityTool('save@1', writeSpec)],
        });
        return new LlmAgent({
          name: 'outer',
          model: host.adk.llm('agent'),
          tools: [new AgentTool({ agent: inner })],
        });
      },
      { chatModels: { mock: model } },
      {
        signal: new AbortController().signal,
        models: preparation,
      },
    ),
  ).rejects.toMatchObject({ code: 'unsupported' });
  expect(model.seen).toHaveLength(0);
});
