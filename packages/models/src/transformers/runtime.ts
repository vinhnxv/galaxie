// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ModelError } from '../errors.js';
import { deniedFetch, type ReadOnlyModelCache } from './model-files.js';
import { localModelKey, type TransformersModelRecord } from './model-record.js';
import type { DeviceReport, FinishReason, GenerateRequest } from './protocol.js';

/** URLs the host's Worker entry resolved for the ORT assets (ADR-0021 decision 13). */
export interface OrtAssetUrls {
  readonly mjs: string;
  readonly wasm: string;
}

export interface RuntimeLoadOptions {
  readonly record: TransformersModelRecord;
  readonly cache: ReadOnlyModelCache;
  readonly assets: OrtAssetUrls;
}

export interface RuntimeGenerateOptions {
  readonly request: GenerateRequest;
  readonly contextWindow: number;
  readonly onText: (text: string) => void;
  readonly signal: AbortSignal;
}

export interface RuntimeGenerateResult {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly finishReason: FinishReason;
}

export interface LoadedRuntime {
  readonly device: DeviceReport;
  generate(options: RuntimeGenerateOptions): Promise<RuntimeGenerateResult>;
  dispose(): Promise<void>;
}

/** The only place galaxie touches the library; tests replace it with a fake. */
export interface TransformersRuntime {
  load(options: RuntimeLoadOptions): Promise<LoadedRuntime>;
}

// Structural views of the parts of the library used here. The library is imported dynamically
// and without its types, so these describe only what this file calls.
interface Tensorish {
  readonly dims: readonly number[];
}
interface TokenizerLike {
  apply_chat_template(
    messages: unknown[],
    options: Record<string, unknown>,
  ): { input_ids: Tensorish } & Record<string, unknown>;
}
interface ModelLike {
  generate(options: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<unknown>;
}
interface StoppingCriteria {
  interrupt(): void;
}
interface LibraryModule {
  readonly env: Record<string, unknown> & {
    readonly backends: { readonly onnx: { wasm?: Record<string, unknown> } };
  };
  readonly AutoTokenizer: {
    from_pretrained(id: string, options: Record<string, unknown>): Promise<TokenizerLike>;
  };
  readonly AutoModelForCausalLM: {
    from_pretrained(id: string, options: Record<string, unknown>): Promise<ModelLike>;
  };
  readonly TextStreamer: new (tokenizer: TokenizerLike, options: Record<string, unknown>) => object;
  readonly InterruptableStoppingCriteria: new () => StoppingCriteria;
}

interface GPUAdapterLike {
  readonly info?: { readonly vendor?: string; readonly architecture?: string };
}

function label(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 128) : '';
}

async function deviceReport(record: TransformersModelRecord): Promise<DeviceReport> {
  if (record.device === 'wasm')
    return { backend: 'wasm', thread: 'worker', vendor: 'wasm', architecture: 'wasm' };
  const gpu = (
    globalThis.navigator as { readonly gpu?: { requestAdapter(): Promise<GPUAdapterLike | null> } }
  ).gpu;
  const adapter = await gpu?.requestAdapter();
  if (adapter === undefined || adapter === null) throw new ModelError('unavailable', 'no_adapter');
  return {
    backend: 'webgpu',
    thread: 'worker',
    vendor: label(adapter.info?.vendor),
    architecture: label(adapter.info?.architecture),
  };
}

function templateMessages(request: GenerateRequest): unknown[] {
  return request.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        }),
  }));
}

function configure(library: LibraryModule, options: RuntimeLoadOptions): void {
  const { env } = library;
  const { record, cache, assets } = options;
  // The library never fetches: every model file is answered from buffers verified earlier.
  env['fetch'] = deniedFetch;
  env['allowRemoteModels'] = false;
  env['allowLocalModels'] = true;
  env['localModelPath'] = '/verified-models/';
  env['remotePathTemplate'] = `{model}/resolve/${record.revision}/`;
  env['useBrowserCache'] = false;
  env['useFSCache'] = false;
  env['useCustomCache'] = true;
  env['useWasmCache'] = false;
  env['customCache'] = {
    async match(key: string): Promise<Response | undefined> {
      const file = record.files.find(
        (entry) =>
          key === localModelKey(record, entry) || key.endsWith(`/${record.revision}/${entry.path}`),
      );
      return file === undefined ? undefined : cache.match(localModelKey(record, file));
    },
    async put(): Promise<never> {
      throw new Error('The verified model cache is read-only.');
    },
  };
  const wasm = env.backends.onnx.wasm;
  if (wasm === undefined) throw new ModelError('unavailable', 'load_failed');
  Object.assign(wasm, {
    wasmPaths: { mjs: assets.mjs, wasm: assets.wasm },
    numThreads: 1,
    proxy: false,
  });
}

/** The real runtime: Transformers.js over onnxruntime-web, started only when a load is requested. */
export const transformersRuntime: TransformersRuntime = {
  async load(options): Promise<LoadedRuntime> {
    const { record } = options;
    const library = (await import('@huggingface/transformers')) as unknown as LibraryModule;
    configure(library, options);
    const device = await deviceReport(record);
    const pretrained = {
      revision: record.revision,
      local_files_only: true,
    };
    const tokenizer = await library.AutoTokenizer.from_pretrained(record.modelId, pretrained);
    const model = await library.AutoModelForCausalLM.from_pretrained(record.modelId, {
      ...pretrained,
      device: record.device,
      dtype: record.dtype,
    });
    return {
      device,
      async generate({ request, contextWindow, onText, signal }): Promise<RuntimeGenerateResult> {
        const inputs = tokenizer.apply_chat_template(templateMessages(request), {
          ...(request.tools === undefined ? {} : { tools: request.tools }),
          add_generation_prompt: true,
          return_dict: true,
        });
        const promptTokens = inputs.input_ids.dims[1] ?? 0;
        if (promptTokens + request.maxTokens > contextWindow) throw new ModelError('invalid');
        const stopping = new library.InterruptableStoppingCriteria();
        let completionTokens = 0;
        // The streamer reports the end-of-sequence token too, so special tokens are not counted.
        const streamer: { special_ids?: ReadonlySet<bigint> } = new library.TextStreamer(
          tokenizer,
          {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: onText,
            token_callback_function: (tokens: readonly bigint[]) => {
              for (const token of tokens)
                if (!streamer.special_ids?.has(token)) completionTokens += 1;
            },
          },
        );
        const interrupt = (): void => stopping.interrupt();
        if (signal.aborted) interrupt();
        signal.addEventListener('abort', interrupt, { once: true });
        try {
          await model.generate({
            ...inputs,
            max_new_tokens: request.maxTokens,
            do_sample: request.temperature > 0,
            ...(request.temperature > 0 ? { temperature: request.temperature } : {}),
            streamer,
            stopping_criteria: [stopping],
          });
        } finally {
          signal.removeEventListener('abort', interrupt);
        }
        return {
          promptTokens,
          completionTokens,
          finishReason: signal.aborted
            ? 'abort'
            : completionTokens >= request.maxTokens
              ? 'length'
              : 'stop',
        };
      },
      async dispose(): Promise<void> {
        await model.dispose();
      },
    };
  },
};
