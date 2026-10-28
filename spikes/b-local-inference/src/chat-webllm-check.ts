// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ChatWebLLM } from '@langchain/community/chat_models/webllm';
import type { MLCEngineInterface } from '@mlc-ai/web-llm';
import type { Message, Session } from './arms/types.js';
import { WEBLLM_MODEL, type WebLLMArm, webllmConfig } from './arms/webllm.js';
import { resetCheck } from './harness.js';
import { type Check, emptyChatCheck, type ResultsV1 } from './results.js';
import { schemaProbe, tasks } from './tasks.js';

const outcome = (passed: boolean, reason: string): Check => ({
  status: passed ? 'passed' : 'failed',
  reason,
});
export async function chatWebLLMCheck(arm: WebLLMArm): Promise<ResultsV1['chatWebLLM']> {
  const engine = arm.engine;
  if (!engine) return emptyChatCheck('worker_engine_not_loaded');
  const result = emptyChatCheck('not_started');
  let fetches = 0;
  let adapters = 0;
  const fetch = globalThis.fetch;
  const gpu = navigator.gpu;
  const requestAdapter = gpu?.requestAdapter;
  let chat: ChatWebLLM;
  try {
    globalThis.fetch = (...args) => {
      fetches++;
      return fetch(...args);
    };
    if (gpu && requestAdapter)
      gpu.requestAdapter = (options) => {
        adapters++;
        return requestAdapter.call(gpu, options);
      };
    chat = new ChatWebLLM({ model: WEBLLM_MODEL, temperature: 0, appConfig: webllmConfig() });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    result.constructionStartedInThread = fetches > 0 || adapters > 0;
  } catch {
    return { ...result, status: 'failed', reason: 'construction_failed' };
  } finally {
    globalThis.fetch = fetch;
    if (gpu && requestAdapter) gpu.requestAdapter = requestAdapter;
  }
  // ChatWebLLM has no supported engine injection API; this narrow cast deliberately overwrites its protected field.
  const injection = chat as unknown as { engine: MLCEngineInterface };
  const native = injection.engine;
  injection.engine = engine;
  await native.unload();
  const create = engine.chat.completions.create;
  const received: { temperature: boolean; schema: boolean; signal: boolean }[] = [];
  engine.chat.completions.create = (async (...args: unknown[]) => {
    const request = args[0] as Parameters<typeof create>[0] & Record<string, unknown>;
    const options = args[1] as Record<string, unknown> | undefined;
    received.push({
      temperature: request['temperature'] === 0,
      schema: request['response_format'] !== undefined,
      signal:
        request['signal'] instanceof AbortSignal || options?.['signal'] instanceof AbortSignal,
    });
    return create.call(engine.chat.completions, request);
  }) as typeof create;
  const controller = new AbortController();
  const callOptions = {
    temperature: 0,
    signal: controller.signal,
    response_format: { type: 'json_object', schema: JSON.stringify(schemaProbe.schema) },
  };
  const messages = (values: Message[]): [Message['role'], string][] =>
    values.map((message) => [message.role, message.content]);
  const feedback = tasks.find((task) => task.id === 'feedback-en');
  try {
    if (!feedback) throw new Error('missing_task');
    try {
      const reply = await chat.invoke(messages(feedback.messages), callOptions);
      result.invoke = outcome(
        typeof reply.content === 'string' && reply.content.length > 0,
        'worker_invoke_observed',
      );
      result.schemaAccepted = true;
    } catch {
      result.invoke = outcome(false, 'invoke_exception');
      result.schemaAccepted = false;
    }
    await engine.resetChat();
    try {
      let chunks = 0;
      for await (const chunk of await chat.stream(messages(feedback.messages), callOptions)) {
        if (chunk.content) chunks++;
      }
      result.stream = outcome(chunks > 0, 'worker_stream_observed');
    } catch {
      result.stream = outcome(false, 'stream_exception');
    }
    result.temperatureReachedEngine = received.some((record) => record.temperature);
    result.schemaReachedEngine = received.some((record) => record.schema);
    result.abortSignalReachedEngine = received.some((record) => record.signal);
    const open = async (): Promise<Session> => {
      let history: Message[] = [];
      return {
        generate: async (request) => {
          const all = [...history, ...request.messages];
          const response = await chat.invoke(messages(all));
          const text = typeof response.content === 'string' ? response.content : '';
          history = [...all, { role: 'assistant', content: text }];
          return { text, constrained: false, executedIn: 'unobserved', aborted: false };
        },
        close: async () => {
          history = [];
        },
      };
    };
    result.resetPerSession = await resetCheck(open, (session, request) =>
      session.generate({ ...request, signal: new AbortController().signal, onChunk: () => {} }),
    );
    result.status = 'completed';
    result.reason = 'call_options_observed_at_worker_engine_boundary';
  } catch {
    result.status = 'failed';
    result.reason = 'check_exception';
  } finally {
    engine.chat.completions.create = create;
    await engine.resetChat();
  }
  return result;
}
