// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  AgentTool,
  BaseLlm,
  type BaseSessionService,
  InMemorySessionService,
  LlmAgent,
  type LlmResponse,
  Runner,
} from '@google/adk';
import { expect, test } from 'vitest';
import { GalaxieSessionService } from '../src/session.js';

class CallbackModel extends BaseLlm {
  constructor() {
    super({ model: 'scripted' });
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { errorCode: 'UNEXPECTED_MODEL_CALL' };
  }
  override async connect(): Promise<never> {
    throw new Error('No live connection.');
  }
}

// This characterization needs no candidate wrapper. Native AgentTool copies state
// through its session service; those services disagree about temporary input keys.
test('native AgentTool temporary input depends on session creation semantics', async () => {
  const copied: unknown[] = [];
  const forwarded: unknown[] = [];
  for (const sessionService of [
    new InMemorySessionService(),
    new GalaxieSessionService(),
  ] satisfies BaseSessionService[]) {
    let calls = 0;
    const inner = new LlmAgent({
      name: 'specialist',
      model: new CallbackModel(),
      beforeModelCallback: ({ context }) => {
        copied.push([context.state.get('k'), context.state.get('temp:x')]);
        context.state.update({ changed: 'yes', 'temp:hidden': 'inner only' });
        return { content: { role: 'model', parts: [{ text: 'inner done' }] }, turnComplete: true };
      },
    });
    const agent = new LlmAgent({
      name: 'outer',
      model: new CallbackModel(),
      tools: [new AgentTool({ agent: inner })],
      beforeAgentCallback: (context) => {
        context.state.update({ k: 'v', 'temp:x': 1 });
        return undefined;
      },
      beforeModelCallback: ({ context }) => {
        expect(context.state.get('temp:x')).toBe(1);
        return {
          content: {
            role: 'model',
            parts:
              calls++ === 0
                ? [{ functionCall: { name: 'specialist', args: { request: 'request' } } }]
                : [{ text: 'outer done' }],
          },
          turnComplete: true,
        };
      },
      afterAgentCallback: (context) => {
        forwarded.push([context.state.get('changed'), context.state.get('temp:hidden')]);
        return undefined;
      },
    });
    const runner = new Runner({ appName: 'native', agent, sessionService });
    await sessionService.createSession({
      appName: 'native',
      userId: 'user',
      sessionId: 'conversation',
    });
    const final: string[] = [];
    for await (const event of runner.runAsync({
      userId: 'user',
      sessionId: 'conversation',
      newMessage: { role: 'user', parts: [{ text: 'delegate' }] },
    }))
      for (const part of event.content?.parts ?? [])
        if (part.text !== undefined) final.push(part.text);
    expect(final.at(-1)).toBe('outer done');
    const stored = await sessionService.getSession({
      appName: 'native',
      userId: 'user',
      sessionId: 'conversation',
    });
    expect(stored?.state['changed']).toBe('yes');
    expect(stored?.state['temp:hidden']).toBeUndefined();
  }
  expect(copied).toEqual([
    ['v', undefined],
    ['v', 1],
  ]);
  expect(forwarded).toEqual([
    ['yes', undefined],
    ['yes', undefined],
  ]);
});
