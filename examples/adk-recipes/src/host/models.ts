// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition, ModelDownloadRequest, ModelRouting } from '@galaxie-ai/core';
import {
  checkTransformersModel,
  loadTransformersEngine,
  ModelError,
  parseModelRecord,
  TransformersChatModel,
  type TransformersEngineHandle,
  type TransformersModelRecord,
  type TransformersWorker,
} from '@galaxie-ai/models/transformers';

/**
 * One reply's token limit, for the router reservation and for generation. Later agents receive the
 * earlier replies in their prompt, and the 4096-token context must fit the whole prompt plus the
 * reply: the default 1024 left the third agent with a 4007-token prompt and no room to answer.
 */
const replyTokens = 384;

export { default as pinnedModelRecord } from './model-records/qwen3.5-0.8b-onnx-opt-q4.json' with {
  type: 'json',
};

export interface OnnxModels {
  readonly chatModels: Readonly<Record<string, TransformersChatModel>>;
  readonly routing: ModelRouting;
  dispose(): Promise<void>;
}

/** A reviewed record is the only source of model identity and tool-format claims. */
export function createOnnxModels(
  definition: AgentDefinition,
  value: unknown,
  options: {
    readonly createWorker: () => TransformersWorker;
    readonly confirmDownload: (request: ModelDownloadRequest) => boolean | Promise<boolean>;
  },
): OnnxModels {
  let record: TransformersModelRecord;
  try {
    record = parseModelRecord(value);
  } catch {
    return { chatModels: {}, routing: { providers: {}, roles: {} }, async dispose() {} };
  }
  const roles: Record<string, ModelRouting['roles'][string]> = {};
  for (const [role, needs] of Object.entries(definition.models ?? {})) {
    if (needs.requires?.includes('tool-calling') && record.toolFormat === undefined) continue;
    roles[role] = { providers: ['onnx'], allow: ['in-browser'], maxTokens: replyTokens };
  }
  if (Object.keys(roles).length === 0)
    return { chatModels: {}, routing: { providers: {}, roles }, async dispose() {} };

  let loading: Promise<TransformersEngineHandle> | undefined;
  let disposed = false;
  const lifetime = new AbortController();
  const load = (
    allowDownload: boolean,
    signal?: AbortSignal,
  ): Promise<TransformersEngineHandle> => {
    if (disposed) return Promise.reject(new ModelError('unavailable'));
    loading ??= loadTransformersEngine({
      worker: options.createWorker(),
      model: record,
      allowDownload,
      signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
    });
    return loading;
  };
  const model = new TransformersChatModel(
    {
      modelId: record.modelId,
      toolFormat: record.toolFormat,
      async *stream(request, signal) {
        yield* (await load(false, signal)).stream(request, signal);
      },
    },
    { maxTokens: replyTokens },
  );
  return {
    chatModels: { onnx: model },
    routing: {
      providers: {
        onnx: {
          destination: 'in-browser',
          modality: 'text',
          languages: ['en'],
          features: [
            'streaming',
            'cancellation',
            ...(record.toolFormat === undefined ? [] : (['tool-calling'] as const)),
          ],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles,
      availability: () =>
        disposed ? { status: 'unavailable' } : checkTransformersModel({ model: record }),
      download: async (request) => {
        if (!(await options.confirmDownload(request))) return false;
        request.signal.throwIfAborted();
        await load(true, request.signal);
        return true;
      },
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      await loading?.then(
        (handle) => handle.dispose(),
        () => undefined,
      );
    },
  };
}
