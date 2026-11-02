// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import '../../../packages/adapter-adk/test/support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  GalaxieError,
  type RunEvent,
  toErrorInfo,
} from '@galaxie/core';
import { createMockLatch, MockChatModel, type MockScript } from '@galaxie/models/mock';
import {
  BaseLlm,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  StreamingMode,
} from '@google/adk';
import type { ToolCall } from '@langchain/core/messages';
import { z } from 'zod';
import {
  type AdkAgent,
  createAdkAdapter,
  defineAdkEntry,
} from '../../../packages/adapter-adk/src/index.js';
import specs from '../cases-adk/fixtures.json' with { type: 'json' };

export const adkCases = [
  'plain-text',
  'capability',
  'sequential-tools',
  'output-schema',
  'capability-denial',
  'argument-block',
  'step-budget',
  'abort',
  'streaming-text',
  'streaming-tool',
  'approval-approve',
  'approval-deny',
] as const;
export type AdkCase = (typeof adkCases)[number];

const STEP_LIMIT = 2;
const isStreaming = (name: AdkCase): boolean => name.startsWith('streaming-');
const isApproval = (name: AdkCase): boolean => name.startsWith('approval-');
const approves = (name: AdkCase): boolean => name === 'approval-approve';
const BLOCKED = /BLOCKED_(ARGUMENT|TEXT)/;
const TOOL = 'math_double_1';
const TOOL_DESCRIPTION = 'Double an integer.';
const parameters = z.object({ value: z.number().int(), note: z.string().optional() });

interface Spec {
  readonly prompt: string;
  readonly replies: readonly { readonly text: string; readonly toolCalls?: readonly ToolCall[] }[];
}

type Part =
  | { readonly text: string }
  | { readonly functionCall: { readonly name: string; readonly args: unknown } }
  | { readonly functionResponse: { readonly name: string; readonly response: unknown } };

interface Content {
  readonly role: string;
  readonly parts: readonly Part[];
}

export interface AdkTranscript {
  readonly requests: { system: unknown; contents: Content[]; tools: unknown[] }[];
  readonly responses: Content[];
  readonly capabilities: { name: string; input: unknown }[];
  /** Streaming cases only: the text deltas in order and the content-free tool step markers. */
  streamed?: string[];
  steps?: { step: string; tool: string; index: number }[];
  /** Approval cases only: the tool calls the run paused on, in order. */
  pauses?: { tool: string; args: unknown }[];
  output: unknown;
  error: { code: string } | null;
}

function specOf(name: AdkCase): Spec {
  const spec = (specs as Record<string, Spec>)[name];
  if (spec === undefined) throw new Error('The conformance script is missing.');
  return spec;
}

/** Call IDs are runtime-generated on each side, so the transcripts compare names and payloads. */
function normalizeContent(content: { role?: string; parts?: readonly unknown[] }): Content {
  const parts: Part[] = [];
  for (const raw of content.parts ?? []) {
    const part = raw as {
      text?: string;
      functionCall?: { name?: string; args?: unknown };
      functionResponse?: { name?: string; response?: unknown };
    };
    if (part.functionCall !== undefined)
      parts.push({
        functionCall: { name: part.functionCall.name ?? '', args: part.functionCall.args ?? {} },
      });
    else if (part.functionResponse !== undefined)
      parts.push({
        functionResponse: {
          name: part.functionResponse.name ?? '',
          response: part.functionResponse.response ?? {},
        },
      });
    else if (typeof part.text === 'string') parts.push({ text: part.text });
  }
  return { role: content.role ?? '', parts };
}

function record(transcript: AdkTranscript, request: LlmRequest): void {
  const config = request.config ?? {};
  const declarations = (config.tools ?? []).flatMap(
    (tool) => (tool as { functionDeclarations?: unknown[] }).functionDeclarations ?? [],
  );
  transcript.requests.push({
    system: config.systemInstruction ?? null,
    contents: request.contents.map(normalizeContent),
    tools: structuredClone(declarations),
  });
}

function responseContent(response: LlmResponse): Content {
  return normalizeContent(response.content ?? { role: 'model', parts: [] });
}

function newTranscript(name: AdkCase): AdkTranscript {
  return {
    requests: [],
    responses: [],
    capabilities: [],
    ...(isStreaming(name) ? { streamed: [], steps: [] } : {}),
    ...(isApproval(name) ? { pauses: [] } : {}),
    output: null,
    error: null,
  };
}

const instruction = 'Use the supplied tools and answer briefly.';

function agentFor(name: AdkCase, model: BaseLlm, tool: FunctionTool | undefined): LlmAgent {
  return new LlmAgent({
    name: 'agent',
    model,
    instruction,
    ...(name === 'output-schema'
      ? { outputSchema: z.object({ answer: z.string() }), outputKey: 'result' }
      : tool === undefined
        ? {}
        : { tools: [tool] }),
  });
}

/** The fixed text the capability broker returns to the model for a denial or invalid input. */
function modelVisible(code: 'denied' | 'invalid'): { error: string } {
  return { error: toErrorInfo(code).message };
}

/** ADK without galaxie: a scripted model, ADK's own tool, runner and run limits. */
class ScriptedLlm extends BaseLlm {
  readonly #replies: Spec['replies'];
  readonly #transcript: AdkTranscript;
  readonly #latch: ReturnType<typeof createMockLatch> | undefined;
  #index = 0;
  denied = false;

  constructor(
    spec: Spec,
    transcript: AdkTranscript,
    latch: ReturnType<typeof createMockLatch> | undefined,
  ) {
    super({ model: 'scripted' });
    this.#replies = spec.replies;
    this.#transcript = transcript;
    this.#latch = latch;
  }

  override async *generateContentAsync(
    request: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    record(this.#transcript, request);
    await this.#latch?.wait(abortSignal);
    const reply = this.#replies[this.#index++];
    if (reply === undefined) throw new Error('The scripted reply is missing.');
    const calls = (reply.toolCalls ?? []).map((call) => ({
      functionCall: { name: call.name, args: call.args },
    }));
    if (BLOCKED.test(JSON.stringify([reply.text, calls]))) {
      this.denied = true;
      throw new Error('Blocked by the host check.');
    }
    const parts = [...(reply.text === '' ? [] : [{ text: reply.text }]), ...calls];
    const response: LlmResponse = { content: { role: 'model', parts }, turnComplete: true };
    if (stream === true)
      for (const word of reply.text.match(/\S+\s*/g) ?? [])
        yield { content: { role: 'model', parts: [{ text: word }] }, partial: true };
    this.#transcript.responses.push(responseContent(response));
    yield response;
  }

  override async connect(): Promise<never> {
    throw new Error('The scripted model has no live connection.');
  }
}

function codeOf(errorCode: string, message: string, denied: boolean): string {
  if (errorCode === 'INVOCATION_ABORTED') return 'cancelled';
  if (denied) return 'denied';
  if (/llm calls limit/i.test(message)) return 'budget_exceeded';
  return 'unavailable';
}

export async function runAdkNative(name: AdkCase): Promise<AdkTranscript> {
  const spec = specOf(name);
  const transcript = newTranscript(name);
  const latch = name === 'abort' ? createMockLatch() : undefined;
  const tool = new FunctionTool({
    name: TOOL,
    description: TOOL_DESCRIPTION,
    parameters,
    ...(isApproval(name) ? { requireConfirmation: true } : {}),
    execute: async (input: z.infer<typeof parameters>) => {
      transcript.capabilities.push({ name: 'math.double@1', input });
      if (name === 'capability-denial') return modelVisible('denied');
      return { value: input.value * 2 };
    },
  });
  const model = new ScriptedLlm(spec, transcript, latch);
  const agent = agentFor(name, model, tool);
  const runner = new InMemoryRunner({ agent, appName: 'conformance' });
  const session = await runner.sessionService.createSession({
    appName: 'conformance',
    userId: 'fixture',
  });
  const controller = new AbortController();
  let text = '';
  let delta: unknown;
  /** Runs one invocation; returns the confirmation call a gated tool is waiting on, if any. */
  const drive = async (message: {
    role: string;
    parts: Record<string, unknown>[];
  }): Promise<string | undefined> => {
    let waiting: string | undefined;
    for await (const event of runner.runAsync({
      userId: 'fixture',
      sessionId: session.id,
      newMessage: message,
      runConfig: {
        maxLlmCalls: name === 'step-budget' ? STEP_LIMIT : 500,
        streamingMode: isStreaming(name) ? StreamingMode.SSE : StreamingMode.NONE,
      },
      abortSignal: controller.signal,
    })) {
      if (event.errorCode !== undefined) {
        // ADK reports a failed run as an error event rather than throwing.
        transcript.error = {
          code: codeOf(event.errorCode, event.errorMessage ?? '', model.denied),
        };
        break;
      }
      if (Object.keys(event.actions?.requestedToolConfirmations ?? {}).length > 0) {
        for (const part of event.content?.parts ?? []) {
          const call = part.functionCall;
          if (call?.name !== 'adk_request_confirmation') continue;
          const pinned = call.args?.['originalFunctionCall'] as { name: string; args: unknown };
          transcript.pauses?.push({ tool: pinned.name, args: pinned.args });
          waiting = call.id;
        }
        continue;
      }
      if (event.partial === true) {
        for (const part of event.content?.parts ?? [])
          if (typeof part.text === 'string') transcript.streamed?.push(part.text);
      } else {
        for (const part of event.content?.parts ?? []) {
          const call = part.functionCall ?? part.functionResponse;
          if (call?.name !== undefined)
            transcript.steps?.push({
              step: part.functionCall === undefined ? 'tool_result' : 'tool_call',
              tool: call.name,
              index: transcript.steps?.length ?? 0,
            });
        }
      }
      if (event.partial !== true && event.author === 'agent' && event.content?.role === 'model') {
        const answer = (event.content.parts ?? [])
          .flatMap((part) => (typeof part.text === 'string' ? [part.text] : []))
          .join('');
        if ((event.content.parts ?? []).every((part) => part.functionCall === undefined)) {
          text = answer;
          delta = event.actions?.stateDelta;
        }
      }
    }
    return waiting;
  };
  try {
    const events = (async () => {
      const waiting = await drive({ role: 'user', parts: [{ text: spec.prompt }] });
      if (waiting !== undefined)
        await drive({
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: waiting,
                name: 'adk_request_confirmation',
                response: { confirmed: approves(name) },
              },
            },
          ],
        });
    })();
    if (latch !== undefined) {
      await latch.entered;
      controller.abort();
    }
    await events;
    if (transcript.error === null)
      transcript.output =
        name === 'output-schema' ? Reflect.get(delta as Record<string, unknown>, 'result') : text;
  } catch {
    transcript.error = { code: 'unavailable' };
  } finally {
    latch?.release();
  }
  return JSON.parse(JSON.stringify(transcript)) as AdkTranscript;
}

/** The same agent through galaxie: the adapter, router, broker and output-safety hook. */
export async function runAdkGalaxie(name: AdkCase): Promise<AdkTranscript> {
  const spec = specOf(name);
  const transcript = newTranscript(name);
  const latch = createMockLatch();
  const script: MockScript = {
    [spec.prompt]: spec.replies.map((reply, index) => ({
      ...reply,
      id: `reply-${index}`,
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      ...(name === 'abort' ? { wait: latch } : {}),
    })),
  };
  const adapter = createAdkAdapter() as ExecutorAdapter<unknown, unknown>;
  const runtime = createRuntime({
    appId: 'adk-conformance',
    executors: [adapter],
    budgets: { steps: name === 'step-budget' ? STEP_LIMIT : 25, toolCalls: 10, tokens: 2000 },
    outputSafety: ({ text }) => (BLOCKED.test(text) ? 'block' : 'allow'),
  });
  const agent: AdkAgent = (host) => {
    const llm = host.adk.llm('answer');
    const generate = llm.generateContentAsync.bind(llm);
    llm.generateContentAsync = async function* (request, stream, signal) {
      record(transcript, request);
      const recorded = transcript.requests.length;
      try {
        for await (const response of generate(request, stream, signal)) {
          // Partial responses are the stream; the transcript compares complete responses.
          if (response.partial !== true) transcript.responses.push(responseContent(response));
          yield response;
        }
      } catch (error) {
        // ADK's call limit refuses before it asks the model, so a request that galaxie's step
        // budget refused before dispatch is not a model request on either side.
        if (error instanceof GalaxieError && error.code === 'budget_exceeded')
          transcript.requests.splice(recorded - 1, 1);
        throw error;
      }
    };
    const root = agentFor(
      name,
      llm,
      host.adk.capabilityTool('math.double@1', {
        toolName: TOOL,
        description: TOOL_DESCRIPTION,
        parameters,
        ...(isApproval(name) ? { requireConfirmation: true } : {}),
      }),
    );
    return isApproval(name)
      ? defineAdkEntry({
          agent: root,
          interaction: (requests) => {
            for (const pending of requests)
              if (pending.kind === 'confirmation')
                transcript.pauses?.push({ tool: pending.tool, args: pending.args });
            return {
              surfaceId: 'main',
              viewRevision: 'r1',
              component: 'conformance.Approval/v1',
              props: { count: requests.length },
            };
          },
        })
      : root;
  };
  try {
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/adk',
        version: '1.0.0',
        executor: 'adk-js',
        input: z.object({ prompt: z.string() }),
        models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
        capabilities: {
          required: {
            'math.double@1': {
              kind: 'read',
              input: parameters,
              output: z.object({ value: z.number().int() }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: new MockChatModel(script) } },
        bindings: {
          'math.double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: z.infer<typeof parameters>) {
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
              features: ['tool-calling', 'structured-output'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ prompt: spec.prompt });
    const events = (async (): Promise<RunEvent[]> => {
      const recorded: RunEvent[] = [];
      for await (const event of instance.events(runId)) {
        recorded.push(event);
        if (event.type === 'interaction') {
          const receipt = await instance.dispatch({
            instanceId: instance.instanceId,
            runId,
            ...event.interaction,
            action: approves(name) ? 'approve' : 'deny',
            payload: { indexes: [0] },
          });
          if (receipt.status !== 'accepted') throw new Error('The approval was not accepted.');
        }
      }
      return recorded;
    })();
    if (name === 'abort') {
      await latch.entered;
      await instance.cancel(runId);
    }
    for (const event of await events) {
      if (event.type === 'stream' && event.executor === 'adk-js') {
        const data = event.data as { text?: string; step?: string; tool?: string; index?: number };
        if (event.mode === 'messages' && typeof data.text === 'string')
          transcript.streamed?.push(data.text);
        else if (event.mode === 'updates')
          transcript.steps?.push({
            step: data.step ?? '',
            tool: data.tool ?? '',
            index: data.index ?? -1,
          });
      } else if (event.type === 'output') transcript.output = event.output;
      else if (event.type === 'error') transcript.error = { code: event.error.code };
      else if (event.type === 'cancelled') transcript.error = { code: 'cancelled' };
    }
    return JSON.parse(JSON.stringify(transcript)) as AdkTranscript;
  } finally {
    latch.release();
    await runtime.dispose();
  }
}
