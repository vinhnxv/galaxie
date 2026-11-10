// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
/*
 * Outcome rule fixed before measurement (full cross-lane table in
 * python/galaxie/tests/test_pydantic_ai_native_tools.py): supported needs a
 * repository provider, bridge declaration/result channel, router feature and
 * broker grant/label/budget/confirmation proof. Alternative needs failed support,
 * a retrieval kind and satisfied N4. Otherwise refusal needs fixed unsupported
 * and zero model/capability/interaction traffic. A P0 bypass is unsafe as shipped;
 * unmeasured P0 makes the cell undetermined. Observed gaps remain green pins.
 * N1: both prepare entries refuse static tools with zero requests.
 * N2: request refuses unsupported with zero requests.
 * N4: equal ordinary/local-search traffic, exactly one model request with one
 * function declaration and no extra option, one capability call, positional scope.
 * N6: baseline/function/capability tools prepare and run.
 * D1: factories refuse at prepare or request with zero requests.
 * RP3: array content refuses unsupported before Python reply, one model call,
 * zero capability calls. RP4 is reasoned and unmeasured.
 */

import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  missingPythonWheels,
  type PythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import {
  type BridgeMessage,
  type CapabilityPayload,
  type ModelPayload,
  parseBridge,
} from '../../packages/adapter-pyodide/src/bridge.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { type PydanticTranscript, RecordingModel } from './support/pydantic-ai.js';

const kinds = [
  'advisor',
  'code_execution',
  'file_search',
  'image_generation',
  'mcp_server',
  'memory',
  'tool_search',
  'web_fetch',
  'web_search',
  'x_search',
] as const;

const agents = `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from pydantic_ai import Agent
from pydantic_ai.capabilities import NativeTool, WebSearch
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.native_tools import NATIVE_TOOL_TYPES, WebSearchTool
from galaxie.pydantic_ai import Executor, GalaxieModel, capability_tool

PARAMETERS = {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}
ARGUMENTS = {
    'advisor': {'model': 'claude-sonnet-4-5'},
    'file_search': {'file_store_ids': ['inert-store']},
    'mcp_server': {'id': 'inert-server', 'url': 'https://invalid.example/mcp'},
}

def native_entry(kind, executor=False):
    def create():
        tool = NATIVE_TOOL_TYPES[kind](**ARGUMENTS.get(kind, {}))
        agent = Agent(GalaxieModel('answer'), capabilities=[NativeTool(tool)])
        return Executor(agent) if executor else agent
    return create

for kind in NATIVE_TOOL_TYPES:
    globals()['native_' + kind] = native_entry(kind)
    globals()['executor_' + kind] = native_entry(kind, True)

class DirectExecutor(Executor):
    def __init__(self, kind):
        super().__init__(Agent(GalaxieModel('answer')))
        self.native_tool = NATIVE_TOOL_TYPES[kind](**ARGUMENTS.get(kind, {}))

    async def run(self, value, thread_id, steps, **kwargs):
        return await GalaxieModel('answer').request(
            [], None, ModelRequestParameters(native_tools=[self.native_tool]),
        )

def direct_entry(kind):
    return lambda: DirectExecutor(kind)

for kind in NATIVE_TOOL_TYPES:
    globals()['request_' + kind] = direct_entry(kind)

def native_optional():
    return Agent(GalaxieModel('answer'), capabilities=[NativeTool(WebSearchTool(optional=True))])

def default_search():
    return Agent(GalaxieModel('answer'), capabilities=[WebSearch()])

def late_tool_search():
    agent = Agent(GalaxieModel('answer'))
    agent.root_capability.capabilities = [
        *agent.root_capability.capabilities,
        NativeTool(NATIVE_TOOL_TYPES['tool_search']()),
    ]
    return agent

def executor_late_tool_search():
    return Executor(late_tool_search())

def factory_tool():
    return Agent(GalaxieModel('answer'), capabilities=[NativeTool(lambda ctx: WebSearchTool())])

def factory_none():
    return Agent(GalaxieModel('answer'), capabilities=[NativeTool(lambda ctx: None)])

def baseline():
    return Agent(GalaxieModel('answer'))

def ordinary():
    def search(query: str) -> str:
        return 'unused'
    return Agent(GalaxieModel('answer'), tools=[search])

def capability_search():
    return Agent(GalaxieModel('answer'), tools=[capability_tool('search', 'docs.search@1', PARAMETERS)])

def local_search():
    tool = capability_tool('search', 'docs.search@1', PARAMETERS)
    return Agent(GalaxieModel('answer'), capabilities=[WebSearch(native=False, local=tool)])
`;

const definition = defineAgentDefinition({
  id: 'tests/pydantic-ai-native-tools',
  version: '1.0.0',
  executor: 'pydantic-ai-python',
  input: z.object({ prompt: z.string() }),
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.search@1': {
        kind: 'read',
        input: z.object({ query: z.string() }),
        output: z.object({ text: z.string() }),
      },
    },
  },
});

const models = {
  providers: {
    mock: {
      destination: 'in-browser' as const,
      modality: 'text' as const,
      languages: ['en'],
      features: ['tool-calling' as const, 'streaming' as const],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { answer: { providers: ['mock'], allow: ['in-browser' as const], maxTokens: 100 } },
};

function transcript(): PydanticTranscript {
  return {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
}

function requests(raw: readonly string[]): BridgeMessage[] {
  return raw.map((message) => parseBridge(message)).filter((message) => message.kind === 'request');
}

function errors(events: readonly RunEvent[]): unknown[] {
  return events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
}

function outputs(events: readonly RunEvent[]): unknown[] {
  return events.flatMap((event) => (event.type === 'output' ? [event.output] : []));
}

async function measure(
  fixture: PythonFixture,
  entry: string,
  model: BaseChatModel,
): Promise<{
  events: RunEvent[];
  bridge: BridgeMessage[];
  replies: BridgeMessage[];
  capabilities: unknown[];
}> {
  const sent = fixture.fromWorker.length;
  const received = fixture.toWorker.length;
  const capabilities: unknown[] = [];
  const runtime = createRuntime({
    appId: 'pydantic-native-tools',
    executors: [createPyodideAdapter({ ...fixture.options, framework: 'pydantic-ai' })],
    budgets: { steps: 10, tokens: 1000, toolCalls: 5 },
    outputSafety: () => 'allow',
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'fixture',
      agent: { ...fixture.agent, entry },
      recovery: new MemoryRecoveryStore(),
      services: { chatModels: { mock: model } },
      models,
      bindings: {
        'docs.search@1': {
          kind: 'read',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 1,
          grantScope: 'instance',
          approval: 'none',
          retry: 'none',
          async invoke(input: { query: string }) {
            capabilities.push(input);
            return { text: 'found' };
          },
        },
      },
    });
    await instance.prepare();
    const { runId } = await instance.start({ prompt: 'search' });
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) events.push(event);
    return {
      events,
      bridge: requests(fixture.fromWorker.slice(sent)),
      replies: fixture.toWorker.slice(received).map((raw) => parseBridge(raw)),
      capabilities,
    };
  } finally {
    await runtime.dispose();
  }
}

const probe = test.skipIf(!pythonWheelsAvailable);
const unsupported = { code: 'unsupported', message: 'This operation is unsupported.' };

// N1/N2/D1: characterize prepare acceptance before the conditional validation change.
probe(
  `native static tools and factories before bridge dispatch (${missingPythonWheels} if skipped)`,
  async () => {
    const fixture = await createPythonFixture({
      framework: 'pydantic-ai',
      module: 'agents',
      sources: { 'agents.py': agents },
    });
    try {
      for (const entry of [
        ...kinds
          .filter((kind) => kind !== 'tool_search')
          .flatMap((kind) => [`native_${kind}`, `executor_${kind}`]),
        ...kinds.map((kind) => `request_${kind}`),
        'native_optional',
        'default_search',
        'late_tool_search',
        'executor_late_tool_search',
        'factory_tool',
      ]) {
        const recorded = transcript();
        const model = new RecordingModel({ search: [{ id: 'reply-1', text: 'done' }] }, recorded);
        const result = await measure(fixture, entry, model);
        // Prepare acceptance violates the static refusal condition; request refusal is pinned.
        expect(errors(result.events), entry).toEqual([
          expect.objectContaining(
            entry.includes('late_tool_search')
              ? { code: 'executor_error', message: 'The executor or agent code failed.' }
              : unsupported,
          ),
        ]);
        expect(outputs(result.events), entry).toEqual([]);
        expect(
          result.bridge.filter((message) => ['model', 'capability'].includes(message.op)),
          entry,
        ).toEqual([]);
        expect(recorded.requests, entry).toEqual([]);
        expect(result.capabilities, entry).toEqual([]);
        expect(
          result.events.filter((event) => event.type === 'interaction'),
          entry,
        ).toEqual([]);
      }
      // A user-passed required tool_search conflicts with the injected optional one upstream.
      for (const entry of ['native_tool_search', 'executor_tool_search']) {
        const sent = fixture.fromWorker.length;
        const recorded = transcript();
        await expect(
          measure(
            fixture,
            entry,
            new RecordingModel({ search: [{ id: 'reply-1', text: 'done' }] }, recorded),
          ),
          entry,
        ).rejects.toMatchObject({
          code: 'unavailable',
          message: 'The requested service is unavailable.',
        });
        expect(
          requests(fixture.fromWorker.slice(sent)).filter((message) =>
            ['model', 'capability'].includes(message.op),
          ),
          entry,
        ).toEqual([]);
        expect(recorded.requests, entry).toEqual([]);
      }
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  240000,
);

// N6/D1: the implicit optional tool search and a factory returning None can run today.
probe(
  'baseline, ordinary tools and an empty native factory complete without capability work',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'pydantic-ai',
      module: 'agents',
      sources: { 'agents.py': agents },
    });
    try {
      for (const entry of ['baseline', 'ordinary', 'factory_none']) {
        const recorded = transcript();
        const result = await measure(
          fixture,
          entry,
          new RecordingModel({ search: [{ id: 'reply-1', text: 'done' }] }, recorded),
        );
        expect(errors(result.events), entry).toEqual([]);
        expect(outputs(result.events), entry).toEqual(['done']);
        expect(recorded.requests, entry).toHaveLength(1);
        expect(
          result.bridge.filter((message) => message.op === 'model'),
          entry,
        ).toHaveLength(1);
        expect(result.capabilities, entry).toEqual([]);
      }
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

// N4: pin equal broker traffic, including the two requests that fail the fixed one-request rule.
probe(
  'ordinary capability search and explicit local search have equal transcripts',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'pydantic-ai',
      module: 'agents',
      sources: { 'agents.py': agents },
    });
    try {
      const transcripts: PydanticTranscript[] = [];
      const payloads: unknown[][] = [];
      for (const entry of ['capability_search', 'local_search']) {
        const recorded = transcript();
        const result = await measure(
          fixture,
          entry,
          new RecordingModel(
            {
              search: [
                {
                  id: 'reply-1',
                  text: '',
                  toolCalls: [{ id: 'search-1', name: 'search', args: { query: 'galaxie' } }],
                },
                { id: 'reply-2', text: 'done' },
              ],
            },
            recorded,
          ),
        );
        expect(errors(result.events), entry).toEqual([]);
        expect(outputs(result.events), entry).toEqual(['done']);
        expect(recorded.requests, entry).toHaveLength(2);
        const modelRequests = result.bridge.filter((message) => message.op === 'model');
        expect(modelRequests, entry).toHaveLength(2);
        for (const request of modelRequests) {
          if (request.kind !== 'request') throw new Error('A model request is missing.');
          const payload = request.payload as ModelPayload;
          expect(Object.keys(payload.options).sort()).toEqual(['stream', 'toolChoice', 'tools']);
          expect(payload.options.tools).toHaveLength(1);
          expect(payload.options.tools?.[0]?.type).toBe('function');
        }
        const capabilityRequests = result.bridge.filter((message) => message.op === 'capability');
        expect(capabilityRequests, entry).toHaveLength(1);
        const request = capabilityRequests[0];
        if (request?.kind !== 'request') throw new Error('The capability request is missing.');
        expect(request.payload).toEqual({
          name: 'docs.search@1',
          input: { query: 'galaxie' },
          effectScope: expect.stringMatching(/^pydantic-ai\/[^/]+\/1\/0$/),
          tool: true,
        } satisfies Omit<CapabilityPayload, 'effectScope'> & { effectScope: unknown });
        expect(result.capabilities).toEqual([{ query: 'galaxie' }]);
        expect(result.events.filter((event) => event.type === 'interaction')).toEqual([]);
        transcripts.push(recorded);
        payloads.push(
          modelRequests.map((message) => (message.kind === 'request' ? message.payload : null)),
        );
      }
      // RecordingModel imports the existing conformance normalization unchanged.
      expect(transcripts[1]).toEqual(transcripts[0]);
      expect(payloads[1]).toEqual(payloads[0]);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);

class NativePartsModel extends BaseChatModel {
  calls = 0;
  constructor() {
    super({});
  }
  override _llmType(): string {
    return 'native-parts-probe';
  }
  override async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++;
    return {
      generations: [
        {
          text: 'unchecked text',
          message: new AIMessage({
            content: [
              { type: 'text', text: 'unchecked text' },
              { type: 'server_tool_call', id: 'native-1', name: 'web_search', args: {} },
              { type: 'web_search_call', id: 'native-1', status: 'completed' },
            ],
          }),
        },
      ],
    };
  }
}

// RP3: provider blocks must fail before a successful Python model reply or capability work.
probe(
  'native provider content blocks fail at the adapter without a Python reply',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'pydantic-ai',
      module: 'agents',
      sources: { 'agents.py': agents },
    });
    try {
      const model = new NativePartsModel();
      const result = await measure(fixture, 'baseline', model);
      expect(model.calls).toBe(1);
      expect(errors(result.events)).toEqual([expect.objectContaining(unsupported)]);
      expect(
        result.events.filter((event) => event.type === 'output' || event.type === 'interaction'),
      ).toEqual([]);
      expect(result.bridge.filter((message) => message.op === 'model')).toHaveLength(1);
      expect(result.bridge.filter((message) => message.op === 'capability')).toEqual([]);
      expect(result.capabilities).toEqual([]);
      const replies = result.replies.filter(
        (message) => message.op === 'model' && message.kind === 'response',
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ ok: false, error: { code: 'unsupported' } });
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
  90000,
);
