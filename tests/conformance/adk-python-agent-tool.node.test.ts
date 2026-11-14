// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityName,
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  galaxieField,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
  type ToolCall,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  type PythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const source = `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from google.adk.agents import LlmAgent
from google.adk.tools import AgentTool, FunctionTool
from galaxie.adk import Executor, agent_tool, capability_tool, llm, loop_exit, toolset

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}

def read():
    return capability_tool('read', 'math.read@1', PARAMETERS, 'Read an integer.')

def inner(tools=None):
    return LlmAgent(name='inner', description='Answer one question.', model=llm('inner'), tools=tools or [], output_key='changed')

def wrapped():
    return Executor(LlmAgent(name='outer', model=llm('outer'), tools=[agent_tool(inner()), read()]))

def wrapped_read():
    return Executor(LlmAgent(name='outer', model=llm('outer'), tools=[agent_tool(inner([read()])), read()]))

def direct():
    return Executor(LlmAgent(name='outer', model=llm('outer'), tools=[read()]))

def refused(kind):
    agent = inner()
    if kind == 'nested':
        agent.tools = [agent_tool(LlmAgent(name='nested', model=llm('inner')))]
    elif kind in ('confirm', 'long_running'):
        agent.tools = [capability_tool('read', 'math.read@1', PARAMETERS, 'Read.',
            require_confirmation=kind == 'confirm', long_running=kind == 'long_running')]
    elif kind == 'input_schema':
        from pydantic import BaseModel
        class Input(BaseModel):
            request: str
        agent.input_schema = Input
    elif kind == 'output_schema':
        from pydantic import BaseModel
        class Output(BaseModel):
            answer: str
        agent.output_schema = Output
    elif kind == 'missing_model':
        agent.model = ''
    elif kind == 'foreign_agent':
        class Foreign(LlmAgent):
            pass
        agent = Foreign(name='inner', model=llm('inner'))
    elif kind == 'duplicate':
        agent.name = 'outer'
    elif kind == 'exit':
        agent.tools = [loop_exit()]
    elif kind == 'toolset':
        agent.tools = [toolset([read()])]
    elif kind == 'request_input':
        def ask(request: str):
            return request
        agent.tools = [FunctionTool(ask)]
    wrapper = AgentTool(agent) if kind == 'raw' else agent_tool(agent)
    tools = [wrapper]
    if kind == 'collision':
        tools.append(capability_tool('inner', 'math.read@1', PARAMETERS, 'Read.'))
    return Executor(LlmAgent(name='outer', model=llm('outer'), tools=tools))

for kind in ('raw', 'nested', 'confirm', 'long_running', 'input_schema', 'output_schema',
             'missing_model', 'foreign_agent', 'duplicate', 'exit', 'toolset', 'request_input', 'collision'):
    globals()['refused_' + kind] = lambda selected=kind: refused(selected)
`;

type Reply =
  | { text: string; calls?: readonly ToolCall[] }
  | { error: Error }
  | { wait: PromiseWithResolvers<void> };
type Request = { agent: string; messages: BaseMessage[] };

/** A deterministic provider shared by every routed role, recording each complete request. */
class ScriptedModel extends BaseChatModel {
  readonly requests: Request[] = [];
  readonly entered = Promise.withResolvers<void>();
  readonly replies: readonly Reply[];
  #next = 0;
  constructor(replies: readonly Reply[]) {
    super({});
    this.replies = replies;
  }
  override _llmType(): string {
    return 'adk-python-agent-tool-gates';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const system = messages.find((message) => message.type === 'system');
    const text = typeof system?.content === 'string' ? system.content : '';
    const agent = /Your internal name is "([^"]+)"/.exec(text)?.[1] ?? '';
    this.requests.push({ agent, messages });
    const reply = this.replies[this.#next++];
    if (!reply) throw new Error('The scripted reply is missing.');
    if ('error' in reply) throw reply.error;
    if ('wait' in reply) {
      this.entered.resolve();
      await Promise.race([
        reply.wait.promise,
        new Promise<never>((_, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        ),
      ]);
      throw new Error('The waiting script was released.');
    }
    return {
      generations: [
        {
          text: reply.text,
          message: new AIMessage<StandardMessageStructure>({
            content: reply.text,
            ...(reply.calls ? { tool_calls: [...reply.calls] } : {}),
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        },
      ],
    };
  }
}

const delegate = (id = 'provider-wrapper'): ToolCall => ({
  id,
  name: 'inner',
  args: { request: 'inner question' },
});
const read = (value = 1): ToolCall => ({ id: 'provider-read', name: 'read', args: { value } });
const text = (value: string): Reply => ({ text: value });
const call = (...calls: ToolCall[]): Reply => ({ text: '', calls });
const store = () => ({
  checkpoints: new MemoryByteCheckpoints(),
  recovery: new MemoryRecoveryStore(),
});

interface HostOptions {
  entry?: string;
  sessionId?: SessionId;
  kind?: 'read' | 'write';
  approval?: 'none' | 'confirm';
  missing?: boolean;
  privateOutput?: boolean;
  remoteOuter?: boolean;
  runGrant?: boolean;
  steps?: number;
  toolCalls?: number;
  bindingError?: 'unavailable' | 'denied' | 'invalid';
}

async function host(
  fixture: PythonFixture,
  replies: readonly Reply[],
  bytes = store(),
  options: HostOptions = {},
) {
  const model = new ScriptedModel(replies);
  const invoked: number[] = [];
  const checks: string[] = [];
  const baseAdapter = createPyodideAdapter({ ...fixture.options, framework: 'adk' });
  const conversation = options.sessionId;
  // The host only adopts pending runs. Exercise a completed conversation at the adapter seam,
  // retaining the real new runtime's router, broker, restore-data registration and payload budget.
  const adapter: typeof baseAdapter =
    conversation === undefined
      ? baseAdapter
      : {
          ...baseAdapter,
          async prepare(agent, services, preparation) {
            const worker = await baseAdapter.prepare(agent, services, preparation);
            return {
              run(request) {
                return worker.run({ ...request, sessionId: conversation });
              },
              pending(_sessionId, readOptions) {
                return worker.pending(conversation, readOptions);
              },
              dispose() {
                return worker.dispose();
              },
            };
          },
        };
  const runtime = createRuntime({
    appId: 'adk-python-agent-tool-gates',
    executors: [adapter],
    budgets: { steps: options.steps ?? 15, toolCalls: options.toolCalls ?? 10, tokens: 5000 },
    outputSafety: ({ text: value }) => {
      checks.push(value);
      return value.includes('BLOCKED_INNER') ? 'block' : 'allow';
    },
  });
  const schema = z.object({ value: z.number().int() });
  const role = {
    modality: 'text' as const,
    languages: ['en'],
    defaultPolicy: 'remote-allowed' as const,
  };
  const provider = {
    modality: 'text' as const,
    languages: ['en'],
    features: ['streaming', 'tool-calling'] as const,
    pricing: { inputPerToken: 0, outputPerToken: 0 },
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'tests/adk-python-agent-tool-gates',
      version: '1.0.0',
      executor: 'adk-python',
      input: z.object({ prompt: z.string().meta(galaxieField({ label: 'public' })) }),
      models: { outer: role, inner: role },
      capabilities: {
        optional: {
          'math.read@1': {
            kind: options.kind ?? 'read',
            input: schema,
            output: options.privateOutput
              ? schema.meta(galaxieField({ label: 'private-user' }))
              : schema,
          },
        },
      },
    }),
    {
      principalScope: 'fixture',
      agent: { ...fixture.agent, entry: options.entry ?? 'wrapped_read' },
      recovery: bytes.recovery,
      services: { chatModels: { local: model, remote: model }, checkpoints: bytes.checkpoints },
      models: {
        consent: () => true,
        providers: {
          local: { ...provider, destination: 'in-browser' },
          remote: { ...provider, destination: 'host-server' },
        },
        roles: {
          outer: {
            providers: [options.remoteOuter ? 'remote' : 'local'],
            allow: [options.remoteOuter ? 'host-server' : 'in-browser'],
            maxTokens: 100,
          },
          inner: { providers: ['local'], allow: ['in-browser'], maxTokens: 100 },
        },
      },
      bindings: options.missing
        ? {}
        : {
            'math.read@1': {
              kind: options.kind ?? 'read',
              destination: 'in-browser',
              timeoutMs: 1000,
              concurrency: 2,
              grantScope: options.runGrant ? 'run' : 'instance',
              approval: options.approval ?? 'none',
              retry: 'none',
              async invoke(input: { value: number }) {
                invoked.push(input.value);
                if (options.bindingError)
                  throw new GalaxieError(options.bindingError, 'Fixture failure.');
                return { value: input.value * 2 };
              },
            },
          },
    },
  );
  return { runtime, instance, model, invoked, checks, bytes };
}

type Host = Awaited<ReturnType<typeof host>>;
async function run(current: Host, prompt = 'question', grants?: readonly CapabilityName[]) {
  const started = await current.instance.start({ prompt }, grants ? { grants } : undefined);
  const events: RunEvent[] = [];
  for await (const event of current.instance.events(started.runId)) events.push(event);
  return {
    events,
    output: events.findLast((event) => event.type === 'output')?.output,
    error: events.findLast((event) => event.type === 'error')?.error,
  };
}
function saved(bytes: ReturnType<typeof store>) {
  return [...bytes.checkpoints.rows.values()].map((row) => ({
    id: row.id,
    record: JSON.parse(new TextDecoder().decode(row.checkpoint.bytes)),
    metadata: JSON.parse(new TextDecoder().decode(row.metadata.bytes)),
  }));
}
function history(messages: BaseMessage[]): unknown[] {
  return messages
    .filter((message) => message.type !== 'system')
    .map((message) => ({
      type: message.type,
      content: message.content,
      ...('tool_calls' in message ? { calls: message.tool_calls } : {}),
      ...('tool_call_id' in message ? { id: message.tool_call_id } : {}),
    }));
}

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool shares routed budgets and keeps inner events outside persisted and streamed outer events',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    const current = await host(fixture, [
      call(delegate()),
      call(read()),
      text('INNER_ONLY'),
      text('outer done'),
    ]);
    try {
      await current.instance.prepare();
      const result = await run(current);
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('outer done');
      expect(current.model.requests.map((request) => request.agent)).toEqual([
        'outer',
        'inner',
        'inner',
        'outer',
      ]);
      expect(current.invoked).toEqual([1]);
      expect(current.checks).toContain('INNER_ONLY');
      const records = saved(current.bytes);
      expect(records.length).toBeGreaterThan(0);
      expect(
        records
          .at(-1)
          ?.record.events.every((event: { author: string }) =>
            ['user', 'outer'].includes(event.author),
          ),
      ).toBe(true);
      expect(records.at(-1)?.record.events).toContainEqual(
        expect.objectContaining({
          author: 'outer',
          actions: expect.objectContaining({
            stateDelta: expect.objectContaining({ changed: 'INNER_ONLY' }),
          }),
        }),
      );
      const scopes = fixture.fromWorker
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.kind === 'request' && message.op === 'capability')
        .map((message) => message.payload.effectScope);
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toMatch(/^adk-python\/[^/]+\/root\/0\/0\/inner\/root\/0\/0$/);
      expect(
        JSON.stringify(result.events.filter((event) => event.type === 'stream')),
      ).not.toContain('INNER_ONLY');
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await current.runtime.dispose();
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool refuses non-read inner policies before invoking or recording an effect',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    try {
      for (const options of [
        { kind: 'write', approval: 'none' },
        { kind: 'write', approval: 'confirm' },
        { kind: 'read', approval: 'confirm' },
        { missing: true },
      ] satisfies HostOptions[]) {
        const current = await host(
          fixture,
          [call(delegate()), call(read()), text('never')],
          store(),
          options,
        );
        try {
          await current.instance.prepare();
          const before = saved(current.bytes);
          const result = await run(current);
          expect(result.error?.code).toBe('unsupported');
          expect(current.model.requests.map((request) => request.agent)).toEqual([
            'outer',
            'inner',
          ]);
          expect(current.invoked).toEqual([]);
          expect(current.bytes.recovery.journal.size).toBe(0);
          expect(saved(current.bytes)).toEqual(before);
        } finally {
          await current.runtime.dispose();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool preserves broker grants, labels and capability budgets',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    try {
      for (const granted of [false, true]) {
        const current = await host(
          fixture,
          [call(delegate()), call(read()), text('inner done'), text('outer done')],
          store(),
          { runGrant: true },
        );
        try {
          await current.instance.prepare();
          const result = await run(current, 'question', granted ? ['math.read@1'] : []);
          expect(result.error).toBeUndefined();
          expect(result.output).toBe('outer done');
          expect(current.invoked).toEqual(granted ? [1] : []);
          if (!granted)
            expect(JSON.stringify(current.model.requests[2]?.messages)).toContain(
              'Policy denied the request.',
            );
        } finally {
          await current.runtime.dispose();
        }
      }
      for (const entry of ['direct', 'wrapped_read']) {
        const wrapped = entry === 'wrapped_read';
        const replies = wrapped
          ? [call(delegate()), call(read()), text('inner done'), text('never')]
          : [call(read()), text('never')];
        const current = await host(fixture, replies, store(), {
          entry,
          privateOutput: true,
          remoteOuter: true,
        });
        try {
          await current.instance.prepare();
          expect((await run(current)).error?.code).toBe('denied');
          expect(current.invoked).toEqual([1]);
          expect(current.instance.getSnapshot().run?.labels).toContain('private-user');
          expect(current.model.requests.map((request) => request.agent)).toEqual(
            wrapped ? ['outer', 'inner', 'inner'] : ['outer'],
          );
        } finally {
          await current.runtime.dispose();
        }
      }
      const limited = await host(
        fixture,
        [call(delegate()), call(read()), call(read(2)), text('never')],
        store(),
        { toolCalls: 1 },
      );
      try {
        await limited.instance.prepare();
        expect((await run(limited)).error?.code).toBe('budget_exceeded');
        expect(limited.invoked).toEqual([1]);
      } finally {
        await limited.runtime.dispose();
      }
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool fatal failures match an outer-direct control and stop before another outer request',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    try {
      for (const failure of ['provider', 'blocked', 'steps', 'binding'] as const) {
        const codes = [];
        for (const wrapped of [false, true]) {
          const options: HostOptions = {
            entry: wrapped ? 'wrapped_read' : 'direct',
            ...(failure === 'steps' ? { steps: wrapped ? 2 : 1 } : {}),
            ...(failure === 'binding' ? { bindingError: 'unavailable' } : {}),
          };
          const body: Reply[] =
            failure === 'provider'
              ? [{ error: new Error('PRIVATE_PROVIDER_DETAIL') }]
              : failure === 'blocked'
                ? [text('BLOCKED_INNER')]
                : [call(read()), text('never')];
          const current = await host(
            fixture,
            [...(wrapped ? [call(delegate())] : []), ...body, text('never outer')],
            store(),
            options,
          );
          try {
            await current.instance.prepare();
            const result = await run(current);
            expect(result.output).toBeUndefined();
            expect(JSON.stringify(result.error)).not.toContain('PRIVATE_PROVIDER_DETAIL');
            expect(
              current.model.requests.filter((request) => request.agent === 'outer'),
            ).toHaveLength(1);
            codes.push(result.error?.code);
          } finally {
            await current.runtime.dispose();
          }
        }
        expect(codes).toEqual(
          failure === 'provider' || failure === 'binding'
            ? ['unavailable', 'unavailable']
            : failure === 'blocked'
              ? ['denied', 'denied']
              : ['budget_exceeded', 'budget_exceeded'],
        );
      }
      for (const bindingError of ['denied', 'invalid'] as const) {
        const current = await host(
          fixture,
          [call(delegate()), call(read()), text('inner recovered'), text('outer done')],
          store(),
          { bindingError },
        );
        try {
          await current.instance.prepare();
          expect((await run(current)).output).toBe('outer done');
          const tool = current.model.requests[2]?.messages.findLast(
            (message) => message.type === 'tool',
          );
          expect(tool?.content).toBe(
            JSON.stringify({
              error:
                bindingError === 'denied'
                  ? 'Policy denied the request.'
                  : 'The request is invalid.',
            }),
          );
        } finally {
          await current.runtime.dispose();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool keeps gap IDs unique across fresh Workers and rolls back a failed completed-inner turn',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    const bytes = store();
    const first = await host(
      fixture,
      [call(delegate()), call(read()), text('inner done'), call(read(2)), text('first done')],
      bytes,
    );
    let next: Host | undefined;
    try {
      await first.instance.prepare();
      expect((await run(first, 'first')).output).toBe('first done');
      const baseline = saved(bytes);
      const ids = (
        (baseline.at(-1)?.record.events ?? []) as {
          content?: { parts?: { functionCall?: { id: string } }[] };
        }[]
      ).flatMap((event) =>
        (event.content?.parts ?? []).flatMap((part) =>
          part.functionCall ? [part.functionCall.id] : [],
        ),
      );
      expect(ids).toEqual(['galaxie-1', 'galaxie-3']);
      const sessionId = first.instance.sessionId;
      await first.runtime.dispose();
      next = await host(
        fixture,
        [
          call(delegate()),
          text('inner completed'),
          { error: new Error('PRIVATE_AFTER_INNER') },
          call(read(3)),
          text('next done'),
        ],
        bytes,
        { sessionId },
      );
      await next.instance.prepare();
      expect((await run(next, 'failed')).error?.code).toBe('unavailable');
      expect(saved(bytes)).toEqual(baseline);
      const failedHistory = history(next.model.requests[0]?.messages ?? []);
      expect((await run(next, 'next')).output).toBe('next done');
      const nextHistory = history(next.model.requests[3]?.messages ?? []);
      expect(nextHistory.slice(0, -1)).toEqual(failedHistory.slice(0, -1));
      expect(JSON.stringify(nextHistory)).not.toContain('failed');
      const continued = saved(bytes).at(-1)?.record;
      const allIds = (
        continued.events as { content?: { parts?: { functionCall?: { id: string } }[] } }[]
      ).flatMap((event) =>
        (event.content?.parts ?? []).flatMap((part) =>
          part.functionCall ? [part.functionCall.id] : [],
        ),
      );
      expect(allIds).toEqual(['galaxie-1', 'galaxie-3', 'galaxie-4']);
      expect(new Set(allIds).size).toBe(allIds.length);
      const conversation = baseline.at(-1)?.record.conversation_id;
      const scopes = fixture.fromWorker
        .map((raw) => JSON.parse(raw))
        .filter((message) => message.kind === 'request' && message.op === 'capability')
        .map((message) => message.payload.effectScope);
      expect(scopes).toEqual([
        `adk-python/${conversation}/root/0/0/inner/root/0/0`,
        `adk-python/${conversation}/root/1/0`,
        `adk-python/${conversation}/root/2/0`,
      ]);
      expect(new Set(scopes).size).toBe(scopes.length);
      expect(fixture.counts.created).toBe(2);
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await first.runtime.dispose();
      await next?.runtime.dispose();
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool isolates two calls and cancels an inner model without storing the turn',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    const paired = await host(
      fixture,
      [
        call(delegate('first'), delegate('second')),
        text('inner one'),
        text('inner two'),
        text('outer done'),
      ],
      store(),
      { entry: 'wrapped' },
    );
    try {
      await paired.instance.prepare();
      expect((await run(paired)).output).toBe('outer done');
      expect(paired.model.requests.map((request) => request.agent)).toEqual([
        'outer',
        'inner',
        'inner',
        'outer',
      ]);
      const innerRequests = paired.model.requests.filter((request) => request.agent === 'inner');
      expect(innerRequests.every((request) => history(request.messages).length === 1)).toBe(true);
      const events = saved(paired.bytes).at(-1)?.record.events;
      const ids = events.flatMap(
        (event: { content?: { parts?: { functionCall?: { id: string } }[] } }) =>
          (event.content?.parts ?? []).flatMap((part) =>
            part.functionCall ? [part.functionCall.id] : [],
          ),
      );
      expect(ids).toEqual(['galaxie-1', 'galaxie-2']);
    } finally {
      await paired.runtime.dispose();
    }
    try {
      for (const wrapped of [false, true]) {
        const wait = Promise.withResolvers<void>();
        const current = await host(
          fixture,
          [...(wrapped ? [call(delegate())] : []), { wait }],
          store(),
          { entry: wrapped ? 'wrapped' : 'direct' },
        );
        try {
          await current.instance.prepare();
          const before = saved(current.bytes);
          const { runId } = await current.instance.start({ prompt: 'cancel' });
          const collected = (async () => {
            const events = [];
            for await (const event of current.instance.events(runId)) events.push(event);
            return events;
          })();
          await current.model.entered.promise;
          await current.instance.cancel(runId);
          expect((await collected).some((event) => event.type === 'cancelled')).toBe(true);
          expect(saved(current.bytes)).toEqual(before);
          expect(
            current.model.requests.filter((request) => request.agent === 'outer'),
          ).toHaveLength(1);
        } finally {
          wait.resolve();
          await current.runtime.dispose();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'AgentTool rejects every excluded inner shape before model or capability dispatch',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': source },
    });
    try {
      for (const kind of [
        'raw',
        'nested',
        'confirm',
        'long_running',
        'input_schema',
        'output_schema',
        'missing_model',
        'foreign_agent',
        'duplicate',
        'exit',
        'toolset',
        'request_input',
        'collision',
      ]) {
        const current = await host(fixture, [], store(), { entry: `refused_${kind}` });
        try {
          // Entry aliases keep the source's refusal builder independent of the host's input schema.
          await expect(current.instance.prepare()).rejects.toMatchObject({ code: 'unsupported' });
          expect(current.model.requests).toEqual([]);
          expect(current.invoked).toEqual([]);
          expect(current.bytes.checkpoints.rows.size).toBe(0);
        } finally {
          await current.runtime.dispose();
        }
      }
    } finally {
      await fixture.cleanup();
    }
  },
  900000,
);
