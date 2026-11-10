// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  type RunEvent,
} from '@galaxie-ai/core';
import { createMockLatch, MockChatModel, type MockScript } from '@galaxie-ai/models/mock';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { type BaseMessage, HumanMessage, type ToolCall } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';
import specs from '../cases-adk-python/fixtures.json' with { type: 'json' };

export const adkPythonCases = [
  'plain-text',
  'capability',
  'sequential-tools',
  'output-schema',
  'capability-denial',
  'argument-block',
  'step-budget',
  'abort',
  'stream-text',
  'stream-tools',
  'stream-mid-block',
  'stream-abort',
  'confirm-approve',
  'confirm-deny',
  'confirm-two',
  'long-running',
  'confirm-stale',
  'confirm-incomplete',
  'confirm-double-submit',
  'confirm-consecutive',
  'stream-confirm-approve',
  'agents-sequential',
  'agents-parallel',
  'agents-loop',
  'agents-transfer',
  'stream-agents-sequential',
  'agents-confirm-last',
  'agents-confirm-first',
  'agents-confirm-middle',
  'agents-confirm-nested',
  'agents-confirm-parallel',
  'agents-confirm-parallel-reversed',
  'agents-long-running-middle',
] as const;
/** The Chromium lane repeats these; the Node lane runs all of them. */
export const adkPythonBrowserCases = [
  'plain-text',
  'capability',
  'abort',
  'stream-text',
  'stream-abort',
  'confirm-approve',
  'agents-sequential',
  'agents-confirm-last',
] as const;
const stepLimit = 2;
export interface AgentReply {
  readonly text: string;
  readonly toolCalls?: readonly ToolCall[];
  /** The reply waits until this agent has delivered its final answer, which orders parallel branches. */
  readonly after?: string;
  /** The reply waits until this agent has returned a tool call, before it can finish a paused turn. */
  readonly afterCall?: string;
}
export interface Spec {
  readonly prompt: string;
  readonly replies?: readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[];
  readonly agents?: Readonly<Record<string, readonly AgentReply[]>>;
  readonly unordered?: boolean;
  readonly answers?: readonly { readonly action: string; readonly payload: unknown }[];
}
export interface AdkPythonTranscript {
  readonly requests: unknown[];
  readonly responses: unknown[];
  readonly capabilities: unknown[];
  readonly interactions: unknown[];
  readonly streams?: unknown[];
  dispatches?: string[];
  output: unknown;
  error: unknown;
}

function normalizeMessages(messages: BaseMessage[]): unknown[] {
  return messages.map((message) => {
    const role =
      message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type;
    const result: Record<string, unknown> = { role, content: message.content ?? '' };
    if ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      result['tool_calls'] = message.tool_calls.map((call: ToolCall) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
    }
    if ('tool_call_id' in message) result['tool_call_id'] = message.tool_call_id;
    return result;
  });
}
interface Picked {
  readonly agent: string;
  readonly entry: AgentReply;
  readonly id: string;
}

/** The replies of a multi-agent case, shared by every bound copy of the model. */
export class AgentScript {
  readonly replies: Readonly<Record<string, readonly AgentReply[]>>;
  readonly #done = new Map<string, PromiseWithResolvers<void>>();
  constructor(replies: Readonly<Record<string, readonly AgentReply[]>>) {
    this.replies = replies;
  }
  done(agent: string): PromiseWithResolvers<void> {
    let value = this.#done.get(agent);
    if (value === undefined) {
      value = Promise.withResolvers<void>();
      this.#done.set(agent, value);
    }
    return value;
  }
}

export class RecordingModel extends BaseChatModel {
  readonly mock: MockChatModel;
  readonly transcript: AdkPythonTranscript;
  readonly script: MockScript;
  readonly tools: BindToolsInput[];
  readonly choice: unknown;
  readonly streamLatch: ReturnType<typeof createMockLatch> | undefined;
  readonly agents: AgentScript | undefined;
  constructor(
    script: MockScript,
    transcript: AdkPythonTranscript,
    tools: BindToolsInput[] = [],
    choice?: unknown,
    streamLatch?: ReturnType<typeof createMockLatch>,
    agents?: AgentScript,
  ) {
    super({});
    this.agents = agents;
    this.script = script;
    this.transcript = transcript;
    this.tools = tools;
    this.choice = choice;
    this.streamLatch = streamLatch;
    this.mock = tools.length
      ? new MockChatModel(script).bindTools(tools)
      : new MockChatModel(script);
  }
  override _llmType(): string {
    return 'conformance-recording';
  }
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<this['ParsedCallOptions']>,
  ): RecordingModel {
    return new RecordingModel(
      this.script,
      this.transcript,
      tools,
      kwargs?.tool_choice,
      this.streamLatch,
      this.agents,
    );
  }

  /** The agent a request is for and its next reply, which follows the agent's own earlier turns. */
  #pick(messages: BaseMessage[]): Picked | undefined {
    if (!this.agents) return undefined;
    const system = messages.find((message) => message.type === 'system');
    const content = typeof system?.content === 'string' ? system.content : '';
    const agent = /Your internal name is "([^"]+)"/.exec(content)?.[1];
    const turn = messages.filter((message) => message.type === 'ai').length;
    const entry = agent === undefined ? undefined : this.agents.replies[agent]?.[turn];
    if (agent === undefined || entry === undefined)
      throw new Error('The agent script has no reply for this request.');
    return { agent, entry, id: `reply-${agent}-${turn}` };
  }

  #scripted(picked: Picked): MockChatModel {
    return new MockChatModel({
      [picked.agent]: {
        id: picked.id,
        text: picked.entry.text,
        ...(picked.entry.toolCalls === undefined ? {} : { toolCalls: picked.entry.toolCalls }),
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      },
    }).bindTools(this.tools);
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    return this.#respond(messages, options, this.#pick(messages));
  }

  async #respond(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    picked: Picked | undefined,
  ): Promise<ChatResult> {
    const jsonSchema = (options as { jsonSchema?: unknown }).jsonSchema;
    this.transcript.requests.push({
      ...(picked ? { agent: picked.agent } : {}),
      messages: normalizeMessages(messages),
      tools: this.tools,
      ...(this.tools.length ? { toolChoice: this.choice } : {}),
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
    });
    if (picked?.entry.after !== undefined) await this.agents?.done(picked.entry.after).promise;
    if (picked?.entry.afterCall !== undefined)
      await this.agents?.done(`${picked.entry.afterCall}/call`).promise;
    const result = picked
      ? await this.#scripted(picked)._generate([new HumanMessage(picked.agent)], options)
      : await this.mock._generate(messages, options);
    const message = result.generations[0]?.message;
    if (!message) throw new Error('The scripted reply is missing.');
    this.transcript.responses.push({
      ...(picked ? { agent: picked.agent } : {}),
      content: message.content,
      toolCalls: 'tool_calls' in message ? message.tool_calls : [],
    });
    // The gated branch starts after this answer has crossed the bridge; a heuristic margin, not a signal.
    if (picked && !picked.entry.toolCalls?.length) {
      const agents = this.agents;
      setTimeout(() => agents?.done(picked.agent).resolve(), 100);
    }
    if (picked?.entry.toolCalls?.length) {
      const agents = this.agents;
      setTimeout(() => agents?.done(`${picked.agent}/call`).resolve(), 100);
    }
    return result;
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Record the provider's complete scripted reply, including replies blocked during delivery.
    const picked = this.#pick(messages);
    await this.#respond(messages, options, picked);
    const source = picked
      ? this.#scripted(picked)._streamResponseChunks(
          [new HumanMessage(picked.agent)],
          options,
          runManager,
        )
      : this.mock._streamResponseChunks(messages, options, runManager);
    let first = true;
    for await (const chunk of source) {
      yield chunk;
      if (first) await this.streamLatch?.wait(options.signal);
      first = false;
    }
  }
}

/** Parallel branches finish in no fixed order: order what they produced by agent, then by turn. */
export function settle(transcript: AdkPythonTranscript): void {
  const turn = (request: unknown): number =>
    (request as { messages: { role: string }[] }).messages.filter(
      (message) => message.role === 'assistant',
    ).length;
  const agent = (value: unknown): string => (value as { agent: string }).agent;
  const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
  transcript.requests.sort(
    (left, right) => order(agent(left), agent(right)) || turn(left) - turn(right),
  );
  const seen = new Map<string, number>();
  const turns = new Map<unknown, number>();
  for (const response of transcript.responses) {
    seen.set(agent(response), (seen.get(agent(response)) ?? 0) + 1);
    turns.set(response, seen.get(agent(response)) ?? 0);
  }
  transcript.responses.sort(
    (left, right) =>
      order(agent(left), agent(right)) || (turns.get(left) ?? 0) - (turns.get(right) ?? 0),
  );
  transcript.capabilities.sort((left, right) => order(JSON.stringify(left), JSON.stringify(right)));
}

/** Provider call IDs differ per lane (ADK generates one, galaxie assigns one): number them by appearance. */
export function renumber(requests: unknown[]): void {
  const known = new Map<string, string>();
  const number = (id: string): string => {
    const existing = known.get(id);
    if (existing !== undefined) return existing;
    const value = `call-${known.size + 1}`;
    known.set(id, value);
    return value;
  };
  for (const request of requests as { messages: Record<string, unknown>[] }[])
    for (const message of request.messages) {
      for (const call of (message['tool_calls'] as { id: string }[] | undefined) ?? [])
        call.id = number(call.id);
      if (typeof message['tool_call_id'] === 'string')
        message['tool_call_id'] = number(message['tool_call_id']);
    }
}

export async function executeAdkPythonCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
): Promise<AdkPythonTranscript> {
  if (!(adkPythonCases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  const spec = (specs as unknown as Record<string, Spec>)[name];
  if (!spec) throw new Error('The conformance script is missing.');
  const transcript: AdkPythonTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    ...(name.startsWith('stream-') ? { streams: [] } : {}),
    output: null,
    error: null,
  };
  const latch = createMockLatch();
  const script: MockScript = {
    [spec.prompt]: (spec.replies ?? []).map((reply, index) => ({
      ...reply,
      id: `reply-${index}`,
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      ...(name === 'abort' ? { wait: latch } : {}),
    })),
  };
  const model = new RecordingModel(
    script,
    transcript,
    [],
    undefined,
    name === 'stream-abort' ? latch : undefined,
    spec.agents ? new AgentScript(spec.agents) : undefined,
  );
  const runtime = createRuntime({
    appId: 'adk-python-conformance',
    executors: [createPyodideAdapter({ ...options, framework: 'adk' })],
    budgets: { steps: name === 'step-budget' ? stepLimit : 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (/BLOCKED_(ARGUMENT|TEXT)/.test(text) ? 'block' : 'allow'),
  });
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/adk-python',
        version: '1.0.0',
        executor: 'adk-python',
        input: z.object({ prompt: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'math.double@1': {
              kind: 'read',
              input: z.object({ value: z.number().int() }),
              output: z.object({ value: z.number().int() }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: model } },
        ui: {
          surfaces: ['main'],
          components: {
            'tests.Approval/v1': {
              actions: Object.fromEntries(
                ['approve', 'deny', 'submit'].map((action) => [action, { payload: z.unknown() }]),
              ),
            },
          },
        },
        bindings: {
          'math.double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              transcript.capabilities.push({ name: 'math.double@1', input });
              if (name === 'capability-denial')
                throw new GalaxieError('denied', 'Policy denied the request.');
              return { value: input.value * 2 };
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['tool-calling', 'structured-output', 'streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ prompt: spec.prompt });
    const ids = new Set<string>();
    let answerIndex = 0;
    const events = (async (): Promise<RunEvent[]> => {
      const recorded: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        recorded.push(event);
        if (name === 'stream-abort' && event.type === 'stream' && event.mode === 'messages')
          await instance.cancel(runId);
        if (event.type === 'interaction') {
          const pending = instance.getSnapshot().run?.pending;
          if (!pending || ids.has(pending.interactionId))
            throw new Error('The pending interaction is missing or reused.');
          ids.add(pending.interactionId);
          const answer = spec.answers?.[answerIndex++];
          if (!answer) throw new Error('The interaction answer is missing.');
          const submission = {
            instanceId: instance.instanceId,
            runId,
            ...pending,
            ...answer,
            ...(name === 'confirm-stale'
              ? { interactionId: 'wrong' as typeof pending.interactionId }
              : {}),
          };
          const receipts = await Promise.all([
            instance.dispatch(submission),
            ...(name === 'confirm-double-submit' ? [instance.dispatch(submission)] : []),
          ]);
          if (name === 'confirm-double-submit')
            transcript.dispatches = receipts.map((receipt) =>
              receipt.status === 'accepted' ? 'accepted' : `rejected:${receipt.error.code}`,
            );
          if (name === 'confirm-stale') {
            const receipt = receipts[0];
            if (receipt?.status !== 'rejected') throw new Error('The stale answer was accepted.');
            transcript.error = receipt.error;
            break;
          }
          if (receipts[0]?.status !== 'accepted')
            throw new Error('The interaction answer was rejected.');
        }
      }
      return recorded;
    })();
    if (name === 'abort') {
      await latch.entered;
      await instance.cancel(runId);
    }
    for (const event of await events) {
      if (event.type === 'output') transcript.output = event.output;
      else if (event.type === 'error') transcript.error = event.error;
      else if (event.type === 'cancelled')
        transcript.error = { code: 'cancelled', message: 'The run was cancelled.' };
      else if (event.type === 'interaction') {
        transcript.interactions.push({
          ...event.interaction,
          interactionId: `pause-${transcript.interactions.length}`,
        });
      } else if (event.type === 'stream') {
        if (event.executor !== 'adk-python' || event.path.length !== 0)
          throw new Error('The stream has an unexpected executor or path.');
        transcript.streams?.push({ mode: event.mode, data: event.data });
      }
    }
    const actual = JSON.parse(JSON.stringify(transcript)) as AdkPythonTranscript;
    if (spec.unordered) {
      settle(actual);
      // Branches share no call history, so each request numbers its own calls.
      for (const request of actual.requests) renumber([request]);
    } else renumber(actual.requests);
    return actual;
  } finally {
    latch.release();
    await runtime.dispose();
  }
}
