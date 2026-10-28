// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AppConfig,
  CreateWebWorkerMLCEngine,
  hasModelInCache,
  prebuiltAppConfig,
  type WebWorkerMLCEngine,
} from '@mlc-ai/web-llm';
import { gpuProbe } from '../device.js';
import type { Arm, Availability, LoadInfo, Message, Session } from './types.js';
export const WEBLLM_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
const REVISION = '9bd564b064631febf14deadcac492efb761d60c3';
export function webllmConfig(): AppConfig {
  const record = prebuiltAppConfig.model_list.find((record) => record.model_id === WEBLLM_MODEL);
  if (!record) throw new Error('prebuilt_model_missing');
  return {
    ...prebuiltAppConfig,
    model_list: [{ ...record, model: `${record.model}/resolve/${REVISION}/` }],
  };
}
export class WebLLMArm implements Arm {
  readonly id = 'webllm';
  readonly model = { id: WEBLLM_MODEL, revision: REVISION };
  readonly engineVersion = '0.2.86';
  readonly inWorker = true;
  readonly decoding = 'greedy';
  readonly schemaMechanism = 'XGrammar json_object with serialized schema';
  sameCheckpointAs: 'transformers-js' | null = null;
  #engine: WebWorkerMLCEngine | undefined;
  #failure: Promise<never> | undefined;
  guard<T>(operation: Promise<T>): Promise<T> {
    return this.#failure ? Promise.race([operation, this.#failure]) : operation;
  }
  #worker: Worker | undefined;
  get engine(): WebWorkerMLCEngine | undefined {
    return this.#engine;
  }
  async probe(): Promise<Availability> {
    const availability = await gpuProbe();
    if (availability.status === 'unavailable') return availability;
    return {
      status: (await hasModelInCache(WEBLLM_MODEL, webllmConfig())) ? 'available' : 'downloadable',
    };
  }
  async load(progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    const config = webllmConfig();
    const cached = await hasModelInCache(WEBLLM_MODEL, config);
    this.#worker = new Worker(new URL('./webllm.worker.ts', import.meta.url), { type: 'module' });
    const worker = this.#worker;
    this.#failure = new Promise<never>((_resolve, reject) => {
      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        reject(new Error('worker_failed'));
      };
    });
    this.#engine = await this.guard(
      CreateWebWorkerMLCEngine(
        worker,
        WEBLLM_MODEL,
        { appConfig: config, initProgressCallback: () => progress(0) },
        { temperature: 0 },
      ),
    );
    return {
      loadKind: cached ? 'warm' : 'cold',
      reportedBytes: null,
      reason: 'engine_reports_fraction_only',
    };
  }
  async openSession(): Promise<Session> {
    const engine = this.#engine;
    if (!engine) throw new Error('not_loaded');
    await this.guard(engine.resetChat());
    let history: Message[] = [];
    return {
      generate: async (request) => {
        await this.guard(engine.resetChat());
        const messages = [...history, ...request.messages];
        const abort = (): void => engine.interruptGenerate();
        request.signal.addEventListener('abort', abort, { once: true });
        let text = '';
        let outputTokens: number | undefined;
        let executedIn = 'unobserved';
        let aborted = false;
        try {
          if (request.signal.aborted)
            return { text, constrained: false, executedIn, aborted: true };
          const stream = await this.guard(
            engine.chat.completions.create({
              messages,
              stream: true,
              stream_options: { include_usage: true },
              temperature: 0,
              max_tokens: request.maxTokens,
              ...(request.schema
                ? {
                    response_format: {
                      type: 'json_object' as const,
                      schema: JSON.stringify(request.schema),
                    },
                  }
                : {}),
            }),
          );
          const iterator = stream[Symbol.asyncIterator]();
          while (true) {
            const step = await this.guard(iterator.next());
            if (step.done) break;
            const chunk = step.value;
            const scope = (chunk as unknown as { executedIn?: string }).executedIn;
            if (scope) executedIn = scope;
            const delta = chunk.choices[0]?.delta.content ?? '';
            if (delta) {
              text += delta;
              request.onChunk(delta);
            }
            if (chunk.choices.some((choice) => choice.finish_reason === 'abort')) aborted = true;
            if (chunk.usage) outputTokens = chunk.usage.completion_tokens;
          }
          if (!request.signal.aborted)
            history = [...messages, { role: 'assistant', content: text }];
          return {
            text,
            ...(outputTokens === undefined ? {} : { outputTokens }),
            constrained: Boolean(request.schema),
            executedIn,
            aborted,
          };
        } finally {
          request.signal.removeEventListener('abort', abort);
        }
      },
      close: async () => {
        history = [];
        await this.guard(engine.resetChat());
      },
    };
  }
  async dispose(): Promise<void> {
    try {
      if (this.#engine) await this.guard(this.#engine.unload());
    } finally {
      this.#worker?.terminate();
      this.#engine = undefined;
      this.#worker = undefined;
      this.#failure = undefined;
    }
  }
}
