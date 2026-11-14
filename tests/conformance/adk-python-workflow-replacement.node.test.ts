// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime, defineAgentDefinition, type RunEvent } from '@galaxie-ai/core';
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
from google.adk.agents import LlmAgent, ParallelAgent, SequentialAgent
from galaxie.adk import capability_tool, llm

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}

def tree(parallel):
    writers = ('b', 'c') if parallel else ('a', 'b')
    def leaf(name):
        tools = [capability_tool('write', 'notes.write@1', PARAMETERS, 'Store one integer.')] if name in writers else []
        return LlmAgent(name=name, model=llm('answer'), instruction=f'Answer as {name}.', tools=tools)
    return SequentialAgent(name='pipeline', sub_agents=[leaf('a'),
        ParallelAgent(name='fanout', sub_agents=[leaf('b'), leaf('c')]), leaf('merger')]) if parallel else SequentialAgent(
            name='pipeline', sub_agents=[leaf('a'), leaf('b')])

def chain():
    return tree(False)

def fanout():
    return tree(True)
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
  outputs: string[];
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
    [
      'run',
      '--locked',
      '--offline',
      'python',
      '-I',
      'galaxie/tests/test_adk_workflow_replacement.py',
    ],
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
    const name = /Your internal name is "([^"]+)"/.exec(String(system?.content))?.[1];
    if (!name) throw new Error('The scripted stage has no name.');
    this.script.requests.push({ agent: name, messages: mapped, tools: this.tools });
    const afterTool = mapped.at(-1)?.role === 'tool';
    if (name === 'b' && afterTool && this.script.fail) {
      this.script.fail = false;
      throw new Error('Scripted failure after one write.');
    }
    const writers: Record<string, number> = this.script.parallel ? { b: 1, c: 2 } : { a: 1, b: 2 };
    const value = writers[name];
    const calls: ToolCall[] =
      value !== undefined && !afterTool ? [{ id: 'provider', name: 'write', args: { value } }] : [];
    const content = calls.length ? '' : `${name} done`;
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

for (const parallel of [false, true]) {
  for (const retry of [false, true]) {
    test.skipIf(!pythonWheelsAvailable)(
      `Workflow replacement measures request divergence and write replay (${parallel ? 'fanout' : 'chain'}, ${retry ? 'retry' : 'normal'})`,
      async () => {
        const oracle = native[`${parallel ? 'True' : 'False'}-${retry ? 'True' : 'False'}`];
        if (!oracle) throw new Error('The native Workflow observation is missing.');
        const fixture = await createPythonFixture({
          framework: 'adk',
          module: 'replacement',
          sources: { 'replacement.py': source },
        });
        const script: Script = { parallel, fail: retry, requests: [] };
        const model = new StageModel(script);
        const invoked: number[] = [];
        const checkpoints = new MemoryByteCheckpoints();
        const recovery = new MemoryRecoveryStore();
        const runtime = createRuntime({
          appId: 'workflow-replacement',
          executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
          budgets: { steps: 20, toolCalls: 10, tokens: 5000 },
          outputSafety: () => 'allow',
        });
        let stop = (): void => {};
        try {
          const schema = z.object({ value: z.number().int() });
          const instance = await runtime.create(
            defineAgentDefinition({
              id: 'tests/workflow-replacement',
              version: '1.0.0',
              executor: 'adk-python',
              input: z.object({ prompt: z.string() }),
              models: {
                answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' },
              },
              capabilities: {
                required: { 'notes.write@1': { kind: 'write', input: schema, output: schema } },
              },
            }),
            {
              principalScope: 'fixture',
              agent: { ...fixture.agent, entry: parallel ? 'fanout' : 'chain' },
              confirmations: confirmationsFor(['notes.write@1'], 'workflow-replacement-v1'),
              recovery,
              services: { checkpoints, chatModels: { mock: model } },
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
          await instance.prepare();
          stop = autoApprove(instance);
          const outputs: unknown[] = [],
            errors: string[] = [];
          for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            const { runId } = await instance.start({ prompt: 'run the stages' });
            const events: RunEvent[] = [];
            for await (const event of instance.events(runId)) events.push(event);
            for (const event of events) {
              if (event.type === 'output') outputs.push(event.output);
              if (event.type === 'error') errors.push(event.error.code);
            }
            if (retry && attempt === 0) expect(checkpoints.rows.size).toBe(0);
          }
          expect(errors).toEqual(oracle.errors);
          expect(outputs).toEqual(oracle.outputs);
          expect(invoked.sort()).toEqual(oracle.invoked);
          expect(invoked).toEqual([1, 2]);
          expect(recovery.journal.size).toBe(2);
          renumberPerAgent(script.requests);
          expect(requestDigests(script.requests)).not.toEqual(requestDigests(oracle.requests));
          const first = (requests: Request[]): Request => {
            const candidates = requests.filter((request) => request.agent === 'b');
            const picked = candidates.sort(
              (left, right) => left.messages.length - right.messages.length,
            )[0];
            if (!picked) throw new Error('The downstream stage was not requested.');
            return picked;
          };
          const nativeB = first(oracle.requests),
            hostedB = first(script.requests);
          expect(nativeB.messages).toEqual([
            { role: 'system', content: 'Answer as b.' },
            { role: 'user', content: 'a done' },
          ]);
          expect(hostedB.messages[0]).toEqual({
            role: 'system',
            content: 'Answer as b.\n\nYou are an agent. Your internal name is "b".',
          });
          expect(hostedB.messages[1]).toEqual({ role: 'user', content: 'run the stages' });
          expect(hostedB.messages).toHaveLength(parallel ? 3 : 5);
          expect(hostedB.messages.slice(2).every((message) => message.role === 'user')).toBe(true);
          expect(hostedB.messages.at(-1)?.content).toMatch(
            /a done\n<<<END_QUOTED_AGENT_CONTENT>>>$/,
          );
          expect(hostedB.tools).toEqual(nativeB.tools);
          expect(fixture.workerErrors).toEqual([]);
        } finally {
          stop();
          await runtime.dispose();
          await fixture.cleanup();
        }
      },
      900000,
    );
  }
}
