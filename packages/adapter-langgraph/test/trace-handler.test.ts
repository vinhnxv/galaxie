// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunTrace, TraceHandle, TraceResult, TraceStep } from '@galaxie/core';
import { AIMessage, HumanMessage, type StandardMessageStructure } from '@langchain/core/messages';
import type { ChatGeneration } from '@langchain/core/outputs';
import { expect, test } from 'vitest';
import { LangGraphTraceHandler } from '../src/trace-handler.js';

interface RecordedStep {
  readonly step: TraceStep;
  readonly parent: TraceHandle | undefined;
  readonly handle: TraceHandle;
  readonly results: TraceResult[];
}

function recording(): { handler: LangGraphTraceHandler; steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  const trace: RunTrace = {
    recordsText: false,
    start(step, parent) {
      const results: TraceResult[] = [];
      const handle: TraceHandle = { end: (result) => results.push(result) };
      steps.push({ step, parent, handle, results });
      return handle;
    },
  };
  return { handler: new LangGraphTraceHandler(trace), steps };
}

test('observes callbacks without preferring streaming or raising errors', () => {
  const { handler } = recording();
  expect(handler.name).toBe('galaxie-trace');
  expect(handler.awaitHandlers).toBe(true);
  expect(handler.raiseError).toBe(false);
  expect('lc_prefer_streaming' in handler).toBe(false);
});

test('records only named visible nodes and inherits through hidden and wrapper chains', () => {
  const { handler, steps } = recording();
  handler.handleChainStart({}, { secret: 'inputs' }, 'root');
  handler.handleChainStart(
    {},
    {},
    'a',
    'root',
    [],
    { langgraph_node: 'a', langgraph_step: 2, secret: 'metadata' },
    undefined,
    'a',
  );
  handler.handleChainStart(
    {},
    {},
    'hidden',
    'a',
    ['langsmith:hidden'],
    { langgraph_node: 'hidden' },
    undefined,
    'hidden',
  );
  handler.handleChainStart(
    {},
    {},
    'wrapper',
    'hidden',
    [],
    { langgraph_node: 'a' },
    undefined,
    'wrapper',
  );
  handler.handleChatModelStart({}, [], 'model', 'wrapper', { secret: 'params' }, [], {
    ls_provider: 'fixture',
    ls_model_name: 'model-1',
    secret: 'metadata',
  });
  expect(steps.map(({ step }) => step)).toEqual([
    { kind: 'node', name: 'a', step: 2 },
    { kind: 'model', provider: 'fixture', model: 'model-1' },
  ]);
  expect(steps[1]?.parent).toBe(steps[0]?.handle);
  handler.handleChainEnd({ secret: 'outputs' }, 'wrapper');
  handler.handleChainEnd({}, 'hidden');
  expect(steps[0]?.results).toEqual([]);
  const generation: ChatGeneration = {
    text: 'secret-output',
    message: new AIMessage<StandardMessageStructure>({
      content: 'secret-output',
      usage_metadata: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }),
  };
  handler.handleLLMEnd({ generations: [[generation]] }, 'model');
  handler.handleChainEnd({}, 'a');
  expect(steps[1]?.results).toEqual([{ status: 'ok', usage: { inputTokens: 7, outputTokens: 3 } }]);
  expect(steps[0]?.results).toEqual([{ status: 'ok' }]);
  expect(JSON.stringify(steps.map(({ step, results }) => ({ step, results })))).not.toContain(
    'secret',
  );
});

test('ends failed nodes and models with error names only', () => {
  const { handler, steps } = recording();
  handler.handleChainStart({}, {}, 'root');
  handler.handleChainStart(
    {},
    {},
    'node',
    'root',
    [],
    { langgraph_node: 'node' },
    undefined,
    'node',
  );
  handler.handleChatModelStart({}, [], 'model', 'node');
  const error = new TypeError('secret-error');
  handler.handleLLMError(error, 'model');
  handler.handleChainError(error, 'node');
  expect(steps.map(({ results }) => results)).toEqual([
    [{ status: 'error', errorType: 'TypeError' }],
    [{ status: 'error', errorType: 'TypeError' }],
  ]);
});

test.each(['end', 'error'] as const)(
  'settlement waits only for the observed root %s callback',
  async (outcome) => {
    const { handler } = recording();
    await handler.settled();
    handler.handleChainStart({}, {}, 'root');
    handler.handleChainStart({}, {}, 'child', 'root');
    let settled = false;
    const wait = handler.settled().then(() => {
      settled = true;
    });
    handler.handleChainEnd({}, 'child');
    await Promise.resolve();
    expect(settled).toBe(false);
    if (outcome === 'end') handler.handleChainEnd({}, 'root');
    else handler.handleChainError(new Error('secret'), 'root');
    await wait;
    expect(settled).toBe(true);
  },
);

test('a later parentless chain does not move the settlement barrier', async () => {
  const { handler } = recording();
  handler.handleChainStart({}, {}, 'root');
  handler.handleChainStart({}, {}, 'detached');
  let settled = false;
  const wait = handler.settled().then(() => {
    settled = true;
  });
  handler.handleChainEnd({}, 'detached');
  await Promise.resolve();
  expect(settled).toBe(false);
  handler.handleChainEnd({}, 'root');
  await wait;
  expect(settled).toBe(true);
});

test('handleFor resolves live node and inherited wrapper handles only', () => {
  const { handler, steps } = recording();
  expect(handler.handleFor('missing')).toBeUndefined();
  handler.handleChainStart({}, {}, 'root');
  handler.handleChainStart(
    {},
    {},
    'node',
    'root',
    [],
    { langgraph_node: 'node' },
    undefined,
    'node',
  );
  handler.handleChainStart({}, {}, 'wrapper', 'node');
  expect(handler.handleFor('node')).toBe(steps[0]?.handle);
  expect(handler.handleFor('wrapper')).toBe(steps[0]?.handle);
  expect(handler.handleFor('root')).toBeUndefined();
  handler.handleChainEnd({}, 'node');
  expect(handler.handleFor('node')).toBeUndefined();
});

test.each(['ok', 'error'] as const)('model %s end includes the selected route', (status) => {
  const { handler, steps } = recording();
  handler.handleChatModelStart({}, [], 'routed');
  handler.setModelRoute('routed', { providerId: 'local', destination: 'in-browser' });
  if (status === 'ok') handler.handleLLMEnd({ generations: [] }, 'routed');
  else handler.handleLLMError(new Error('private'), 'routed');
  expect(steps[0]?.results[0]).toMatchObject({
    status,
    route: { providerId: 'local', destination: 'in-browser' },
  });
});

test('opt-in model text preserves the generation finish reason', () => {
  const results: TraceResult[] = [];
  const handler = new LangGraphTraceHandler({
    recordsText: true,
    start: () => ({ end: (result) => results.push(result) }),
  });
  handler.handleChatModelStart({}, [], 'text');
  const generation: ChatGeneration = {
    text: 'answer',
    message: new AIMessage({ content: 'answer' }),
    generationInfo: { finish_reason: 'length' },
  };
  handler.handleLLMEnd({ generations: [[generation]] }, 'text');
  expect(results).toEqual([
    {
      status: 'ok',
      usage: {},
      output: [
        {
          role: 'assistant',
          parts: [{ type: 'text', content: 'answer' }],
          finish_reason: 'length',
        },
      ],
    },
  ]);
});

test('opt-in message conversion silently omits unencodable content', () => {
  const steps: TraceStep[] = [];
  const results: TraceResult[] = [];
  const handler = new LangGraphTraceHandler({
    recordsText: true,
    start: (step) => {
      steps.push(step);
      return { end: (result) => results.push(result) };
    },
  });
  const content: unknown[] = [];
  content.push(content);
  const input = new HumanMessage({ content: content as never });
  const generation: ChatGeneration = {
    text: '',
    message: new AIMessage({ content: content as never }),
  };
  expect(() => {
    handler.handleChatModelStart({}, [[input]], 'unencodable');
    handler.handleLLMEnd({ generations: [[generation]] }, 'unencodable');
  }).not.toThrow();
  expect(steps).toEqual([{ kind: 'model' }]);
  expect(results).toEqual([{ status: 'ok', usage: {} }]);
});
