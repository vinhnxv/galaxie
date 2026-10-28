// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ModelError } from '../errors.js';
import type { TextMessage } from '../messages.js';
import { classifyBuiltInAIError } from './classify.js';

export type BuiltInAIAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface BuiltInAILanguages {
  readonly inputLanguages: readonly string[];
  readonly outputLanguages: readonly string[];
}

export interface BuiltInAIProgress {
  readonly phase: 'download';
  readonly fraction: number;
  readonly elapsedSeconds: number;
}

export interface PrepareBuiltInAIOptions extends BuiltInAILanguages {
  readonly onProgress?: (progress: BuiltInAIProgress) => void;
  readonly signal?: AbortSignal;
}

export interface LanguageModelLanguages {
  readonly expectedInputs: readonly {
    readonly type: 'text';
    readonly languages: readonly string[];
  }[];
  readonly expectedOutputs: readonly {
    readonly type: 'text';
    readonly languages: readonly string[];
  }[];
}

export interface LanguageModelCreateOptions extends LanguageModelLanguages {
  readonly initialPrompts?: readonly TextMessage[];
  readonly signal?: AbortSignal;
  readonly monitor?: (monitor: EventTarget) => void;
}

export interface LanguageModelPromptOptions {
  readonly signal?: AbortSignal;
  readonly responseConstraint?: Readonly<Record<string, unknown>>;
  readonly omitResponseConstraintInput?: true;
}

export interface LanguageModelSession {
  promptStreaming(text: string, options: LanguageModelPromptOptions): ReadableStream<string>;
  destroy(): void;
}

export interface LanguageModelAPI {
  availability(options: LanguageModelLanguages): Promise<BuiltInAIAvailability>;
  create(options: LanguageModelCreateOptions): Promise<LanguageModelSession>;
}

/** Read at operation time; importing this subpath never probes the browser. */
export function languageModel(): LanguageModelAPI | undefined {
  return (globalThis as typeof globalThis & { LanguageModel?: LanguageModelAPI }).LanguageModel;
}

export function expectedLanguages(languages: BuiltInAILanguages): LanguageModelLanguages {
  return {
    expectedInputs: [{ type: 'text', languages: languages.inputLanguages }],
    expectedOutputs: [{ type: 'text', languages: languages.outputLanguages }],
  };
}

async function availability(
  api: LanguageModelAPI,
  languages: BuiltInAILanguages,
): Promise<BuiltInAIAvailability> {
  try {
    return await api.availability(expectedLanguages(languages));
  } catch {
    return 'unavailable';
  }
}

/** Availability alone cannot create a session or initiate a download. */
export async function checkBuiltInAI(
  languages: BuiltInAILanguages,
): Promise<BuiltInAIAvailability> {
  const api = languageModel();
  return api === undefined ? 'unavailable' : availability(api, languages);
}

export async function assertCallable(languages: BuiltInAILanguages): Promise<LanguageModelAPI> {
  const api = languageModel();
  if (api === undefined) throw new ModelError('unavailable', 'no_api');
  const status = await availability(api, languages);
  if (status === 'unavailable') throw new ModelError('unavailable', 'unsupported_languages');
  if (status !== 'available') throw new ModelError('unavailable', 'download_required');
  return api;
}

/** Hosts call this from an intentional download click; model calls never download. */
export async function prepareBuiltInAI(options: PrepareBuiltInAIOptions): Promise<void> {
  const started = performance.now();
  options.signal?.throwIfAborted();
  const api = languageModel();
  if (api === undefined) throw new ModelError('unavailable', 'no_api');
  const status = await availability(api, options);
  options.signal?.throwIfAborted();
  if (status === 'unavailable') throw new ModelError('unavailable', 'unsupported_languages');
  if (status !== 'available' && !globalThis.navigator?.userActivation?.isActive)
    throw new ModelError('unavailable', 'activation_required');
  let session: LanguageModelSession | undefined;
  let monitoring = true;
  try {
    session = await api.create({
      ...expectedLanguages(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      monitor: (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          if (!monitoring || options.signal?.aborted) return;
          options.onProgress?.({
            phase: 'download',
            fraction: (event as ProgressEvent).loaded,
            elapsedSeconds: (performance.now() - started) / 1000,
          });
        });
      },
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    const failure = classifyBuiltInAIError(error, 'create');
    if (failure?.code === 'unavailable') throw new ModelError('unavailable', failure.reason);
    throw new ModelError('unavailable', 'download_failed');
  } finally {
    monitoring = false;
    session?.destroy();
  }
}
