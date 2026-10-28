// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type LanguageOptions,
  languages,
  type PromptSession,
  promptApi,
  promptAvailability,
} from '../device.js';
import type { Arm, Availability, LoadInfo, Session } from './types.js';
export class PromptArm implements Arm {
  readonly id = 'prompt-api';
  readonly model = { id: 'browser-managed LanguageModel', revision: null };
  readonly engineVersion = 'browser-managed';
  readonly inWorker = false;
  readonly decoding = 'browser-default';
  readonly schemaMechanism = 'responseConstraint';
  readonly sameCheckpointAs = null;
  readonly #activate: (create: () => Promise<PromptSession>) => Promise<PromptSession>;
  constructor(activate: (create: () => Promise<PromptSession>) => Promise<PromptSession>) {
    this.#activate = activate;
  }
  #options: LanguageOptions = languages('en');
  readonly #sessions = new Set<PromptSession>();
  async probe(): Promise<Availability> {
    const raw = await promptAvailability();
    if (raw.reason === 'api_missing')
      return { status: 'unavailable', reason: 'api_missing', raw: raw.en };
    return raw.en === 'unavailable'
      ? { status: 'unavailable', reason: 'api_unavailable', raw: raw.en }
      : { status: raw.en === 'available' ? 'available' : 'downloadable', raw: raw.en };
  }
  async load(_progress: (loaded: number, total?: number) => void): Promise<LoadInfo> {
    const api = promptApi();
    if (!api) throw new Error('api_missing');
    const availability = await promptAvailability();
    this.#options = languages('en');
    if (availability.enToVi !== 'unavailable')
      this.#options.expectedOutputs[0]?.languages.push('vi');
    const create = (): Promise<PromptSession> =>
      api.create({
        ...this.#options,
        monitor: (monitor) => {
          monitor.addEventListener('downloadprogress', () => _progress(0));
        },
      });
    const session = availability.en === 'available' ? await create() : await this.#activate(create);
    session.destroy();
    return {
      loadKind: availability.en === 'available' ? 'warm' : 'cold',
      reportedBytes: null,
      reason: 'browser_managed_fraction_only',
    };
  }
  async openSession(): Promise<Session> {
    const api = promptApi();
    if (!api) throw new Error('api_missing');
    const session = await api.create(this.#options);
    this.#sessions.add(session);
    return {
      generate: async (request) => {
        let text = '';
        let aborted = false;
        try {
          const stream = session.promptStreaming(request.messages, {
            signal: request.signal,
            // Keep the schema out of the model input, so a schema-valid reply comes from the
            // constraint and not from the model copying the schema's values.
            ...(request.schema
              ? { responseConstraint: request.schema, omitResponseConstraintInput: true }
              : {}),
          });
          for await (const chunk of stream) {
            text += chunk;
            if (chunk) request.onChunk(chunk);
          }
        } catch (error) {
          if (
            request.signal.aborted &&
            error instanceof DOMException &&
            error.name === 'AbortError'
          )
            aborted = true;
          else throw error;
        }
        return {
          text,
          constrained: Boolean(request.schema),
          executedIn: globalThis.constructor.name,
          aborted,
        };
      },
      close: async () => {
        session.destroy();
        this.#sessions.delete(session);
      },
    };
  }
  async dispose(): Promise<void> {
    for (const session of this.#sessions) session.destroy();
    this.#sessions.clear();
  }
}
