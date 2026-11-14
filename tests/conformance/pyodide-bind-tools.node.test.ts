// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition } from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';

const source = `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from typing import Any, cast
from langgraph.graph import StateGraph, START, END
from galaxie.langchain import GalaxieChatModel
from galaxie.langgraph import checkpointer

def refuse():
    GalaxieChatModel(role='answer').bind_tools([])

def factory():
    refuse()

def graph():
    def node(state):
        refuse()
        return state
    return StateGraph(cast(Any, dict)).add_node('node', node).add_edge(START, 'node').add_edge('node', END).compile(checkpointer=checkpointer())
`;

test.each([
  ['factory', 'unavailable'],
  ['graph', 'executor_error'],
])(
  'bind_tools refusal at %s has a characterized fixed code',
  async (entry, code) => {
    const fixture = await createPythonFixture({
      sources: { 'refusal.py': source },
      module: 'refusal',
      entry,
    });
    const runtime = createRuntime({
      appId: 'bind-tools-probe',
      executors: [createPyodideAdapter(fixture.options)],
      outputSafety: () => 'allow',
    });
    try {
      const instance = await runtime.create(
        defineAgentDefinition({
          id: 'conformance/bind-tools',
          version: '1',
          executor: 'langgraph-python',
          input: z.unknown(),
        }),
        { principalScope: 'fixture', agent: fixture.agent },
      );
      if (entry === 'factory') await expect(instance.prepare()).rejects.toMatchObject({ code });
      else {
        await instance.prepare();
        const events = [];
        const { runId } = await instance.start({});
        for await (const event of instance.events(runId)) events.push(event);
        expect(events.find((event) => event.type === 'error')).toMatchObject({
          error: { code },
        });
      }
      expect(fixture.fromWorker.filter((raw) => /"op":"(?:model|capability)"/.test(raw))).toEqual(
        [],
      );
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  900_000,
);
