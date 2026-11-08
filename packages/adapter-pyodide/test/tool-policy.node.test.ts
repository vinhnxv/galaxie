// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, type RunEvent } from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { pythonRagDefinition } from '../../../examples/rag-browser/src/agent/definition-python.js';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../../examples/rag-browser/test/support/python.node.js';
import { MockChatModel } from '../../models/src/mock.js';
import { createPyodideAdapter } from '../src/adapter.js';

async function events(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

const models = {
  providers: {
    mock: {
      destination: 'in-browser' as const,
      modality: 'text' as const,
      features: ['streaming' as const],
      languages: ['en'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: {
    'rag.answer': { providers: ['mock'], allow: ['in-browser' as const], maxTokens: 100 },
  },
};

const binding = {
  destination: 'in-browser' as const,
  timeoutMs: 5000,
  concurrency: 1,
  grantScope: 'instance' as const,
  retry: 'none' as const,
};

const toolGraph = `
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from galaxie.capabilities import call
from galaxie.langgraph import checkpointer
class State(TypedDict, total=False):
    question: str
    mode: str
    answer: str
    citations: list
def create_agent():
    async def act(state, config):
        name, tool = {
            'read-tool': ('docs.search@1', True),
            'write-tool': ('docs.save@1', True),
            'write-direct': ('docs.save@1', False),
            'ghost-tool': ('not.allowed@1', True),
        }[state['question']]
        await call(name, {'query': 'q', 'mode': 'hybrid', 'k': 10}, config, tool=tool)
        return {'answer': 'ready', 'citations': []}
    graph = StateGraph(State)
    graph.add_node('act', act)
    graph.add_edge(START, 'act')
    graph.add_edge('act', END)
    return graph.compile(checkpointer=checkpointer())
`;

// The write capability reuses the search schemas, so one payload shape fits both.
const definition = {
  ...pythonRagDefinition,
  capabilities: {
    required: {
      ...pythonRagDefinition.capabilities.required,
      'docs.save@1': {
        ...pythonRagDefinition.capabilities.required['docs.search@1'],
        kind: 'write' as const,
      },
    },
  },
};

async function toolRun(
  approval: 'none' | 'confirm',
  question: string,
): Promise<{ events: RunEvent[]; saved: number; searched: number }> {
  const fixture = await createPythonFixture({
    sources: { 'tools.py': toolGraph },
    module: 'tools',
  });
  const runtime = createRuntime({
    appId: 'python-tool-policy',
    executors: [createPyodideAdapter(fixture.options)],
    outputSafety: () => 'allow',
  });
  let saved = 0;
  let searched = 0;
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'fixture',
      agent: fixture.agent,
      services: { chatModels: { mock: new MockChatModel({}) } },
      ...(approval === 'confirm'
        ? {
            confirmations: {
              capabilities: ['docs.save@1'],
              policyRevision: () => 'python-tool-policy-v1',
            },
          }
        : {}),
      models,
      bindings: {
        'docs.search@1': {
          ...binding,
          kind: 'read' as const,
          approval: 'none' as const,
          invoke: async () => {
            searched += 1;
            return { passages: [] };
          },
        },
        'docs.save@1': {
          ...binding,
          kind: 'write' as const,
          approval,
          invoke: async () => {
            saved += 1;
            return { passages: [] };
          },
        },
      },
    });
    await instance.prepare();
    const run = await instance.start({ question, mode: 'hybrid' });
    // The broker asks the host before a confirmed write; approve it as soon as it appears.
    const approver = setInterval(() => {
      for (const pending of instance.getSnapshot().confirmations ?? [])
        instance.respond(pending.id, 'approve');
    }, 5);
    try {
      return { events: await events(instance.events(run.runId)), saved, searched };
    } finally {
      clearInterval(approver);
    }
  } finally {
    await runtime.dispose();
    await fixture.cleanup();
  }
}

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'a Python tool helper call runs a read, and refuses a write without a host confirmation'
    : missingPythonWheels,
  async () => {
    const read = await toolRun('none', 'read-tool');
    expect(read.events.at(-1)).toMatchObject({ type: 'output' });
    expect(read.searched).toBe(1);

    // The same write is refused as a model-chosen tool call, before it reaches the capability.
    const refused = await toolRun('none', 'write-tool');
    expect(refused.events.find((event) => event.type === 'error')).toMatchObject({
      error: { code: 'invalid' },
    });
    expect(refused.saved).toBe(0);

    // A direct call from the agent's own code is not a model-chosen tool call and is unchanged.
    const direct = await toolRun('none', 'write-direct');
    expect(direct.events.some((event) => event.type === 'output')).toBe(true);
    expect(direct.saved).toBe(1);

    // A name with no binding has no policy, so the tool flag fails closed.
    const ghost = await toolRun('none', 'ghost-tool');
    expect(ghost.events.find((event) => event.type === 'error')).toMatchObject({
      error: { code: 'invalid' },
    });

    // With a configured host confirmation the write runs once after approval.
    const confirmed = await toolRun('confirm', 'write-tool');
    expect(confirmed.events.some((event) => event.type === 'output')).toBe(true);
    expect(confirmed.saved).toBe(1);
  },
  300000,
);
