// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  GalaxieError,
  type ModelRouting,
  type RunEvent,
} from '@galaxie-ai/core';
import { LlmAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  type AdkHost,
  type AdkPendingRequest,
  createAdkAdapter,
  defineAdkEntry,
} from '../src/index.js';
import { FakeChatModel } from './support/fixtures.js';

/* Scripted Node and Chromium measurement, with the shipped tracker:
 * A-js REFUSED: NA1 fails; GA1-GA5 are inapplicable to a candidate relaxation.
 * B-js REFUSED: NB1 fails; GB1-GB5 are inapplicable to a candidate mixed pause.
 * C-js REFUSED: NC1 fails. AL1/AL2 pass for an ordinary long-running tool;
 * AL3 fails because the reserved name is accepted at construction, reaches the
 * read capability, then fails unsupported without an answerable interaction.
 * The replacement remains usable only with an ordinary, non-reserved name.
 */

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};
const parameters = z.object({
  message: z.string(),
  response_schema: z.record(z.string(), z.unknown()),
});
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const args = { message: 'Name?', response_schema: schema };
const definition = defineAgentDefinition({
  id: 'tests/adk-beside-calls',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'input.ask@1': {
        kind: 'read',
        input: parameters,
        output: z.object({ pending: z.boolean() }),
      },
    },
  },
});

async function setup(names: readonly string[], nativeInput = false) {
  const invocations: unknown[] = [];
  const published: AdkPendingRequest[][] = [];
  const model = new FakeChatModel((_seen, index) =>
    index > 0
      ? new AIMessage({ content: 'finished' })
      : new AIMessage({
          content: '',
          tool_calls: names.map((name, index) => ({
            id: `call-${index}`,
            name,
            args: names.length === 1 ? args : { ...args, message: name },
          })),
        }),
  );
  const runtime = createRuntime({
    appId: 'adk-beside-calls',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 8, toolCalls: 10, tokens: 5000 },
  });
  runtimes.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    services: { chatModels: { mock: model } },
    models: routing,
    agent: (host: AdkHost) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'root',
          model: host.adk.llm('agent'),
          tools: names.map((name) =>
            nativeInput
              ? host.adk.requestInput()
              : host.adk.capabilityTool('input.ask@1', {
                  toolName: name,
                  description: 'Ask a question.',
                  parameters,
                  requireConfirmation: name === 'gated',
                  longRunning: name === 'long' || name === 'ask' || name === 'adk_request_input',
                }),
          ),
        }),
        interaction(requests) {
          published.push([...requests]);
          return {
            surfaceId: 'main',
            viewRevision: 'r1',
            component: 'tests.Question/v1',
            props: { requests },
          };
        },
        resume(requests, action, payload) {
          if (
            action !== 'provide' ||
            typeof payload !== 'object' ||
            payload === null ||
            Object.keys(payload).length !== 1 ||
            !('answer' in payload) ||
            typeof payload.answer !== 'string'
          )
            throw new GalaxieError('invalid', 'The input answer must be valid.');
          return requests.map(() => ({ response: { answer: payload.answer } }));
        },
      }),
    bindings: {
      'input.ask@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(value: unknown) {
          invocations.push(value);
          return { pending: true };
        },
      },
    },
  });
  await instance.prepare();
  const { runId } = await instance.start({ prompt: 'go' });
  const events: RunEvent[] = [];
  for await (const event of instance.events(runId)) {
    events.push(event);
    if (event.type === 'interaction') break;
  }
  return { instance, runId, events, model, invocations, published };
}

for (const names of [
  ['gated', 'ordinary'],
  ['ordinary', 'gated'],
  ['ordinary', 'gated', 'other'],
  ['gated', 'long'],
  ['long', 'gated'],
])
  test(`the shipped tracker refuses ${names.join('/')}`, async () => {
    const seen = await setup(names);
    expect(seen.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
    expect(seen.published).toEqual([]);
    expect(seen.invocations).toEqual(
      names.filter((name) => name !== 'gated').map((name) => ({ ...args, message: name })),
    );
    expect(seen.model.seen).toHaveLength(1);
    const fresh = await seen.instance.start({ prompt: 'again' });
    const events: RunEvent[] = [];
    for await (const event of seen.instance.events(fresh.runId)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'output', output: 'finished' });
    expect(seen.model.seen[1]?.messages.filter((message) => message.type === 'tool')).toEqual([]);
    expect(seen.model.seen[1]?.messages.filter((message) => message.type === 'human')).toHaveLength(
      1,
    );
  });

for (const payload of [{ answer: 'answer-77' }, { answer: 77 }, { answer: 'x', extra: true }])
  test(`ordinary long-running input validates ${JSON.stringify(payload)}`, async () => {
    const seen = await setup(['ask']);
    const pending = seen.events.find((event) => event.type === 'interaction');
    if (pending?.type !== 'interaction') throw new Error('Missing input interaction.');
    expect(seen.published).toEqual([[{ kind: 'long-running', tool: 'ask', args }]]);
    expect(pending.interaction).toMatchObject({
      surfaceId: 'main',
      viewRevision: 'r1',
      component: 'tests.Question/v1',
      props: { requests: seen.published[0] },
    });
    expect(seen.invocations).toEqual([args]);
    const receipt = await seen.instance.dispatch({
      instanceId: seen.instance.instanceId,
      runId: seen.runId,
      ...pending.interaction,
      action: 'provide',
      payload,
    });
    expect(receipt.status).toBe('accepted');
    const events: RunEvent[] = [];
    for await (const event of seen.instance.events(seen.runId)) events.push(event);
    if (typeof payload.answer === 'string' && !('extra' in payload)) {
      expect(events.at(-1)).toMatchObject({ type: 'output', output: 'finished' });
      expect(seen.model.seen).toHaveLength(2);
      expect(
        seen.model.seen[1]?.messages
          .filter((message) => message.type === 'tool')
          .map((message) => JSON.parse(String(message.content))),
      ).toContainEqual({ answer: 'answer-77' });
    } else {
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
      expect(seen.model.seen).toHaveLength(1);
    }
    expect(seen.invocations).toEqual([args]);
  });

test('the native input helper is refused without a capability invocation', async () => {
  const seen = await setup(['adk_request_input'], true);
  expect(seen.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(seen.published).toEqual([]);
  expect(seen.invocations).toEqual([]);
});

test('a reserved-name capability is admitted, runs, then fails without an answerable pause', async () => {
  const seen = await setup(['adk_request_input']);
  expect(seen.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(seen.published).toEqual([]);
  expect(seen.invocations).toEqual([args]);
  expect(seen.model.seen).toHaveLength(1);
});
