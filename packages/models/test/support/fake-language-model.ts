// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  BuiltInAIAvailability,
  LanguageModelAPI,
  LanguageModelCreateOptions,
  LanguageModelLanguages,
  LanguageModelPromptOptions,
  LanguageModelSession,
} from '../../src/builtin-ai/api.js';

export interface FakeLanguageModelOptions {
  readonly availability?: (options: LanguageModelLanguages) => Promise<BuiltInAIAvailability>;
  readonly create?: (options: LanguageModelCreateOptions) => Promise<void>;
  readonly pieces?: readonly string[];
  readonly prompt?: () => void;
  readonly beforeNext?: (index: number) => Promise<void>;
  readonly ignoreStreamAbort?: boolean;
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    void work.catch(() => {});
    throw signal.reason;
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export class FakeLanguageModelSession implements LanguageModelSession {
  readonly prompts: { text: string; options: LanguageModelPromptOptions }[] = [];
  destroys = 0;
  readonly #options: FakeLanguageModelOptions;
  #stop: (() => void) | undefined;

  constructor(options: FakeLanguageModelOptions) {
    this.#options = options;
  }

  promptStreaming(text: string, options: LanguageModelPromptOptions): ReadableStream<string> {
    this.prompts.push({ text, options });
    this.#options.prompt?.();
    let index = 0;
    const pieces = this.#options.pieces ?? ['hello ', '', 'world'];
    const signal = options.signal;
    const onAbort = (): void => this.#stop?.();
    const detach = (): void => signal?.removeEventListener('abort', onAbort);
    return new ReadableStream<string>({
      start: (controller) => {
        this.#stop = (): void => {
          detach();
          controller.error(signal?.reason ?? new DOMException('Destroyed', 'AbortError'));
        };
        if (!this.#options.ignoreStreamAbort)
          signal?.addEventListener('abort', onAbort, { once: true });
      },
      pull: async (controller) => {
        await this.#options.beforeNext?.(index);
        if (!this.#options.ignoreStreamAbort) signal?.throwIfAborted();
        const piece = pieces[index++];
        if (piece === undefined) {
          detach();
          controller.close();
        } else controller.enqueue(piece);
      },
      cancel: () => detach(),
    });
  }

  destroy(): void {
    this.destroys++;
    this.#stop?.();
  }
}

export class FakeLanguageModel implements LanguageModelAPI {
  readonly availabilityCalls: LanguageModelLanguages[] = [];
  readonly creates: LanguageModelCreateOptions[] = [];
  readonly sessions: FakeLanguageModelSession[] = [];
  readonly #options: FakeLanguageModelOptions;

  constructor(options: FakeLanguageModelOptions = {}) {
    this.#options = options;
  }

  async availability(options: LanguageModelLanguages): Promise<BuiltInAIAvailability> {
    this.availabilityCalls.push(options);
    return (await this.#options.availability?.(options)) ?? 'available';
  }

  async create(options: LanguageModelCreateOptions): Promise<LanguageModelSession> {
    this.creates.push(options);
    const monitor = new EventTarget();
    options.monitor?.(monitor);
    for (const loaded of [0, 1]) {
      const event = new Event('downloadprogress');
      Object.defineProperty(event, 'loaded', { value: loaded });
      monitor.dispatchEvent(event);
    }
    await abortable(this.#options.create?.(options) ?? Promise.resolve(), options.signal);
    const session = new FakeLanguageModelSession(this.#options);
    this.sessions.push(session);
    return session;
  }
}

/** Restore the descriptor without reading or invoking a browser's real LanguageModel. */
export function installLanguageModel(fake: LanguageModelAPI | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'LanguageModel');
  Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: fake });
  return () => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'LanguageModel');
    else Object.defineProperty(globalThis, 'LanguageModel', original);
  };
}
