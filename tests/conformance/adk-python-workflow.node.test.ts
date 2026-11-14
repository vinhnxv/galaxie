// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createRuntime,
  defineAgentDefinition,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
  type ToolCall,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { beforeAll, expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { renumberPerAgent } from './support/adk-python.js';
import { autoApprove, confirmationsFor } from './support/auto-confirm.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const source = `# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
from google.adk.agents import LlmAgent
from google.adk.tools import FunctionTool
from google.adk.workflow import JoinNode, FunctionNode, Workflow, RetryConfig
from galaxie.adk import capability_tool, llm, workflow

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}

def tree(parallel):
    writers = ('b', 'c') if parallel else ()
    def leaf(name):
        tools = [capability_tool('write', 'notes.write@1', PARAMETERS, 'Store one integer.')] if name in writers else []
        return LlmAgent(name=name, model=llm('answer'), instruction=f'Answer as {name}.', output_key=f'{name}_result', tools=tools)
    return workflow(name='wf', edges=[('START', leaf('a'), (leaf('b'), leaf('c')), JoinNode(name='join'))]) if parallel else workflow(name='wf', edges=[('START', leaf('a'), leaf('b'))])

def chain():
    return tree(False)

def fanout():
    return tree(True)

def excluded(kind):
    agent = LlmAgent(name='a', model=llm('answer'))
    if kind == 'tool-node':
        def write(value: int) -> dict:
            return {'value': value}
        return workflow(name='wf', edges=[('START', FunctionTool(write))])
    if kind == 'subclass':
        class Custom(Workflow):
            pass
        return Custom(name='wf', edges=[('START', agent)])
    if kind == 'author-function':
        return workflow(name='wf', edges=[('START', FunctionNode(name='authored', func=lambda: 'hidden'))])
    if kind == 'retry':
        agent.retry_config = RetryConfig(max_attempts=2)
    if kind == 'timeout':
        agent.timeout = 1
    if kind == 'rerun':
        agent.rerun_on_resume = True
    if kind == 'parallel-worker':
        agent.parallel_worker = True
    if kind == 'nested':
        return workflow(name='wf', edges=[('START', Workflow(name='inner', edges=[('START', agent)]))])
    if kind == 'cycle':
        return workflow(name='wf', edges=[('START', agent), (agent, {'again': agent})])
    if kind in ('confirmation', 'long-running'):
        agent.tools = [capability_tool('write', 'notes.write@1', PARAMETERS, 'Store one integer.',
            require_confirmation=kind == 'confirmation', long_running=kind == 'long-running')]
    if kind == 'model':
        agent.model = 'unregistered-model'
    root = workflow(name='wf', edges=[('START', agent)])
    if kind == 'repeated-name':
        root.graph.nodes[-1].name = '__START__'
    return root

for kind in ('tool-node', 'subclass', 'author-function', 'retry', 'timeout', 'rerun', 'parallel-worker', 'nested', 'cycle',
             'confirmation', 'long-running', 'model', 'repeated-name'):
    globals()['refused_' + kind.replace('-', '_')] = lambda kind=kind: excluded(kind)
`;

interface Message {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}
interface Request {
  agent: string;
  messages: Message[];
  tools: unknown[];
}
interface Observation {
  requests: Request[];
  invoked: number[];
  outputs: unknown[];
  errors: string[];
}

function requestDigests(requests: Request[]): string[] {
  return requests
    .map((request) =>
      JSON.stringify(request, (_key, value: unknown) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
            )
          : value,
      ),
    )
    .sort();
}

let native: Record<string, Observation>;
beforeAll(async () => {
  const result = await promisify(execFile)(
    'uv',
    ['run', '--locked', '--offline', 'python', '-I', 'galaxie/tests/test_adk_workflow_gates.py'],
    {
      cwd: fileURLToPath(new URL('../../python/', import.meta.url)),
      timeout: 1800000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' },
    },
  );
  native = JSON.parse(result.stdout) as Record<string, Observation>;
}, 900000);

function messagesOf(messages: BaseMessage[]): Message[] {
  return messages.map((message) => ({
    role: message.type === 'ai' ? 'assistant' : message.type === 'human' ? 'user' : message.type,
    content: message.content ?? '',
    ...('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length
      ? {
          tool_calls: message.tool_calls.map((call: ToolCall) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }
      : {}),
    ...('tool_call_id' in message && typeof message.tool_call_id === 'string'
      ? { tool_call_id: message.tool_call_id }
      : {}),
  }));
}

interface Script {
  parallel: boolean;
  fail: boolean;
  requests: Request[];
}

class StageModel extends BaseChatModel {
  readonly script: Script;
  readonly tools: BindToolsInput[];
  constructor(script: Script, tools: BindToolsInput[] = []) {
    super({});
    this.script = script;
    this.tools = tools;
  }
  override _llmType(): string {
    return 'adk-workflow-replacement';
  }
  override bindTools(tools: BindToolsInput[]): StageModel {
    return new StageModel(this.script, tools);
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const mapped = messagesOf(messages);
    const system = mapped.find((message) => message.role === 'system');
    const name = /Answer as ([a-z]+)\./.exec(String(system?.content))?.[1];
    if (!name) throw new Error('The scripted stage has no name.');
    this.script.requests.push({ agent: name, messages: mapped, tools: this.tools });
    const afterTool = mapped.at(-1)?.role === 'tool';
    if (name === 'b' && afterTool && this.script.fail) {
      this.script.fail = false;
      throw new Error('Scripted failure after one write.');
    }
    const writers: Record<string, number> = this.script.parallel ? { b: 1, c: 2 } : {};
    const value = writers[name];
    const calls: ToolCall[] =
      value !== undefined && !afterTool ? [{ id: 'provider', name: 'write', args: { value } }] : [];
    const content = calls.length ? '' : `${name} answer`;
    return {
      generations: [
        {
          text: content,
          message: new AIMessage<StandardMessageStructure>({
            content,
            ...(calls.length ? { tool_calls: calls } : {}),
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        },
      ],
    };
  }
}

async function host(
  fixture: Awaited<ReturnType<typeof createPythonFixture>>,
  fanout: boolean,
  bytes = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() },
  session?: SessionId,
  entry?: string,
) {
  const script: Script = { parallel: fanout, fail: false, requests: [] };
  const model = new StageModel(script);
  const invoked: number[] = [];
  const base = createPyodideAdapter({ ...fixture.options, framework: 'adk' });
  const adapter: typeof base =
    session === undefined
      ? base
      : {
          ...base,
          async prepare(agent, services, preparation) {
            const worker = await base.prepare(agent, services, preparation);
            return {
              run(request) {
                return worker.run({ ...request, sessionId: session });
              },
              pending(_session, options) {
                return worker.pending(session, options);
              },
              dispose() {
                return worker.dispose();
              },
            };
          },
        };
  const runtime = createRuntime({
    appId: 'workflow-candidate',
    executors: [adapter],
    budgets: { steps: 20, toolCalls: 10, tokens: 5000 },
    outputSafety: () => 'allow',
  });
  const schema = z.object({ value: z.number().int() });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'tests/workflow-candidate',
      version: '1.0.0',
      executor: 'adk-python',
      input: z.object({ prompt: z.string() }),
      models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
      capabilities: {
        required: { 'notes.write@1': { kind: 'write', input: schema, output: schema } },
      },
    }),
    {
      principalScope: 'fixture',
      agent: { ...fixture.agent, entry: entry ?? (fanout ? 'fanout' : 'chain') },
      confirmations: confirmationsFor(['notes.write@1'], 'workflow-candidate-v1'),
      recovery: bytes.recovery,
      services: { checkpoints: bytes.checkpoints, chatModels: { mock: model } },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            languages: ['en'],
            features: ['tool-calling', 'streaming'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
      },
      bindings: {
        'notes.write@1': {
          kind: 'write',
          destination: 'in-browser',
          timeoutMs: 1000,
          concurrency: 2,
          grantScope: 'instance',
          approval: 'confirm',
          retry: 'none',
          async invoke(input: { value: number }) {
            invoked.push(input.value);
            return input;
          },
        },
      },
    },
  );
  return { runtime, instance, script, invoked, bytes };
}

async function collect(
  current: Awaited<ReturnType<typeof host>>,
  prompt: string,
): Promise<RunEvent[]> {
  const { runId } = await current.instance.start({ prompt });
  const events: RunEvent[] = [];
  for await (const event of current.instance.events(runId)) events.push(event);
  return events;
}

for (const fanout of [false, true]) {
  test.skipIf(!pythonWheelsAvailable)(
    `Workflow candidate routes ${fanout ? 'fanout' : 'chain'} like native`,
    async () => {
      const fixture = await createPythonFixture({
        framework: 'adk',
        module: 'candidate',
        sources: { 'candidate.py': source },
      });
      const current = await host(fixture, fanout);
      let stop = (): void => {};
      try {
        await current.instance.prepare();
        stop = autoApprove(current.instance);
        const events = await collect(current, 'first');
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        expect(
          events.filter((event) => event.type === 'output').map((event) => event.output),
        ).toEqual(native[fanout ? 'True' : 'False']?.outputs);
        renumberPerAgent(current.script.requests);
        expect(requestDigests(current.script.requests)).toEqual(
          requestDigests(native[fanout ? 'True' : 'False']?.requests ?? []),
        );
        expect(current.invoked.sort()).toEqual(fanout ? [1, 2] : []);
        const authors = events.flatMap((event) =>
          event.type === 'stream' && event.mode === 'messages'
            ? [(event.data as { author: string }).author]
            : [],
        );
        expect([...new Set(authors)].sort()).toEqual(fanout ? ['a', 'b', 'c'] : ['a', 'b']);
        const routed = fixture.fromWorker
          .map((raw) => JSON.parse(raw))
          .filter((message) => message.kind === 'request' && message.op === 'model');
        expect(routed).toHaveLength(current.script.requests.length);
        expect(current.bytes.recovery.journal.size).toBe(fanout ? 2 : 0);
        expect(fixture.workerErrors).toEqual([]);
      } finally {
        stop();
        await current.runtime.dispose();
        await fixture.cleanup();
      }
    },
    900000,
  );
}

test.skipIf(!pythonWheelsAvailable)(
  'Workflow candidate restores a completed chain on a fresh Worker',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'candidate',
      sources: { 'candidate.py': source },
    });
    const first = await host(fixture, false);
    let next: Awaited<ReturnType<typeof host>> | undefined;
    try {
      await first.instance.prepare();
      expect(
        (await collect(first, 'first'))
          .filter((event) => event.type === 'output')
          .map((event) => event.output),
      ).toEqual(['b answer']);
      const session = first.instance.sessionId;
      await first.runtime.dispose();
      next = await host(fixture, false, first.bytes, session);
      await next.instance.prepare();
      const events = await collect(next, 'second');
      expect(events.filter((event) => event.type === 'error')).toEqual([]);
      expect(
        events.filter((event) => event.type === 'output').map((event) => event.output),
      ).toEqual(['b answer']);
      expect(fixture.counts.created).toBe(2);
    } finally {
      await first.runtime.dispose();
      await next?.runtime.dispose();
      await fixture.cleanup();
    }
  },
  900000,
);

test.skipIf(!pythonWheelsAvailable)(
  'Workflow candidate rejects excluded constructs before Worker dispatch',
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'candidate',
      sources: { 'candidate.py': source },
    });
    try {
      for (const kind of [
        'tool_node',
        'subclass',
        'author_function',
        'retry',
        'timeout',
        'rerun',
        'parallel_worker',
        'nested',
        'cycle',
        'confirmation',
        'long_running',
        'model',
        'repeated_name',
      ]) {
        const current = await host(fixture, false, undefined, undefined, `refused_${kind}`);
        const before = fixture.fromWorker.length;
        try {
          await expect(current.instance.prepare()).rejects.toMatchObject({ code: 'unsupported' });
          expect(current.script.requests).toEqual([]);
          expect(current.invoked).toEqual([]);
          const dispatched = fixture.fromWorker
            .slice(before)
            .map((raw) => JSON.parse(raw))
            .filter(
              (message) =>
                message.kind === 'request' && ['model', 'capability'].includes(message.op),
            );
          expect(dispatched).toEqual([]);
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
