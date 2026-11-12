// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  BaseLlm,
  type Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LongRunningFunctionTool,
  requestInputTool,
  StreamingMode,
} from '@google/adk';
import { expect, test } from 'vitest';
import { z } from 'zod';

/* Native ADK 2.3.0, scripted models on Node and Chromium:
 * NA1 FAIL: ordinary siblings run once but their results disappear after the gate.
 * NB1 FAIL: a combined answer loses the long-running answer in either call order.
 * NB2: either split order eventually exposes both results, after an intermediate model call.
 * NC1 FAIL: an LlmAgent never sees the request-input answer.
 * Native failures make the corresponding adapter parity gates inapplicable;
 * no candidate tracker change can repair these losses without rewriting history.
 */

type Content = LlmRequest['contents'][number];
type Part = NonNullable<Content['parts']>[number];
const confirmation = 'adk_request_confirmation';
const input = 'adk_request_input';
const responses = (contents: readonly Content[]): unknown[] =>
  contents.flatMap((content) =>
    (content.parts ?? []).flatMap((part) => part.functionResponse ?? []),
  );

async function measure(names: readonly string[], confirmed = true, split?: 'gate' | 'long') {
  const requests: Content[][] = [];
  const bodies: string[] = [];
  const events: Event[] = [];
  class Scripted extends BaseLlm {
    constructor() {
      super({ model: 'scripted' });
    }
    override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
      requests.push(structuredClone(request.contents));
      yield {
        content: {
          role: 'model',
          parts:
            requests.length === 1
              ? names.map((name, index) => ({
                  functionCall: {
                    id: `call-${index}`,
                    name,
                    args:
                      name === input
                        ? {
                            message: 'Name?',
                            response_schema: {
                              type: 'object',
                              properties: { answer: { type: 'string' } },
                              required: ['answer'],
                            },
                          }
                        : { q: name },
                  },
                }))
              : [{ text: 'finished' }],
        },
      };
    }
    override async connect(): Promise<never> {
      throw new Error('No live connection.');
    }
  }
  const tools = names.map((name) => {
    if (name === input) return requestInputTool;
    const Tool = name === 'long' ? LongRunningFunctionTool : FunctionTool;
    return new Tool({
      name,
      description: 'Record the operation.',
      parameters: z.object({ q: z.string() }),
      requireConfirmation: name === 'gated',
      execute: async () => {
        bodies.push(name);
        return { result: `${name}:pending` };
      },
    });
  });
  const runner = new InMemoryRunner({
    appName: 'beside-native',
    agent: new LlmAgent({ name: 'root', model: new Scripted(), tools }),
  });
  const session = await runner.sessionService.createSession({
    appName: 'beside-native',
    userId: 'u',
  });
  const segment = async (newMessage: Content, pause: boolean): Promise<void> => {
    let flagged = false;
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage,
      runConfig: { streamingMode: StreamingMode.SSE, pauseOnToolCalls: false },
    })) {
      events.push(event);
      if (
        pause &&
        (flagged || event.content?.parts?.some((part) => part.functionCall?.name === confirmation))
      )
        return;
      if (event.longRunningToolIds?.length) flagged = true;
    }
  };
  await segment({ role: 'user', parts: [{ text: 'go' }] }, true);
  const pausedBodies = [...bodies];
  const gate = events
    .flatMap((event) => event.content?.parts ?? [])
    .find((part) => part.functionCall?.name === confirmation)?.functionCall;
  const gateAnswer: Part[] =
    gate?.id === undefined
      ? []
      : [{ functionResponse: { id: gate.id, name: confirmation, response: { confirmed } } }];
  const longIndex = names.findIndex((name) => name === 'long' || name === input);
  const longName = names[longIndex];
  const longAnswer: Part[] =
    longName === undefined
      ? []
      : [
          {
            functionResponse: {
              id: `call-${longIndex}`,
              name: longName,
              response: { answer: 'answer-77' },
            },
          },
        ];
  await segment(
    {
      role: 'user',
      parts:
        split === 'gate'
          ? gateAnswer
          : split === 'long'
            ? longAnswer
            : [...gateAnswer, ...longAnswer],
    },
    false,
  );
  if (split)
    await segment({ role: 'user', parts: split === 'gate' ? longAnswer : gateAnswer }, false);
  return { requests, bodies, pausedBodies };
}

for (const names of [
  ['gated', 'ordinary'],
  ['ordinary', 'gated'],
  ['ordinary', 'gated', 'other'],
]) {
  for (const confirmed of [true, false])
    test(`ordinary siblings lose their results: ${names.join('/')} ${confirmed ? 'approve' : 'deny'}`, async () => {
      const seen = await measure(names, confirmed);
      const ordinary = names.filter((name) => name !== 'gated');
      expect(seen.pausedBodies).toEqual(ordinary);
      expect(seen.bodies).toEqual([...ordinary, ...(confirmed ? ['gated'] : [])]);
      expect(seen.requests).toHaveLength(2);
      expect(responses(seen.requests[0] ?? [])).toEqual([]);
      expect(responses(seen.requests[1] ?? [])).toEqual([
        {
          id: `call-${names.indexOf('gated')}`,
          name: 'gated',
          response: confirmed
            ? { result: 'gated:pending' }
            : { error: 'This tool call is rejected.' },
        },
      ]);
    });
}
for (const names of [
  ['gated', 'long'],
  ['long', 'gated'],
]) {
  for (const confirmed of [true, false])
    for (const split of [undefined, 'gate', 'long'] as const)
      test(`long-running result: ${names.join('/')} ${confirmed ? 'approve' : 'deny'} ${split ?? 'combined'}`, async () => {
        const seen = await measure(names, confirmed, split);
        expect(seen.pausedBodies).toEqual(['long']);
        expect(seen.bodies).toEqual(['long', ...(confirmed ? ['gated'] : [])]);
        const gateResult = {
          id: `call-${names.indexOf('gated')}`,
          name: 'gated',
          response: confirmed
            ? { result: 'gated:pending' }
            : { error: 'This tool call is rejected.' },
        };
        const longResult = {
          id: `call-${names.indexOf('long')}`,
          name: 'long',
          response: { answer: 'answer-77' },
        };
        expect(seen.requests).toHaveLength(split ? 3 : 2);
        expect(responses(seen.requests[0] ?? [])).toEqual([]);
        expect(responses(seen.requests[1] ?? [])).toEqual([
          split === 'long' ? longResult : gateResult,
        ]);
        if (split)
          expect(responses(seen.requests[2] ?? [])).toEqual(
            split === 'gate' ? [gateResult, longResult] : [longResult, gateResult],
          );
      });
}
test('an LlmAgent hides the native request-input answer', async () => {
  const seen = await measure([input]);
  expect(seen.pausedBodies).toEqual([]);
  expect(seen.bodies).toEqual([]);
  expect(seen.requests).toHaveLength(2);
  expect(seen.requests.map(responses)).toEqual([[], []]);
  expect(JSON.stringify(seen.requests.at(-1))).not.toContain('answer-77');
});
