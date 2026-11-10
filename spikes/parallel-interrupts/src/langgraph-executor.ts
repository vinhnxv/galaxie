// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecutorAdapter,
  type ExecutorAgent,
  type ExecutorEvent,
  GalaxieError,
  type InteractionId,
  type PendingInteraction,
  parseInteractionRequest,
  parseSurfaceRecord,
  pendingFromSurface,
  type RunRequest,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import type { MemorySaver } from '@langchain/langgraph-checkpoint';
import { committedResumeValues, type Pause, readPauses } from './checkpoint-reader.js';
import {
  type Counts,
  createFixture,
  type Durability,
  type FixtureGraph,
  type FixtureKind,
} from './graphs.js';

type TopLevelFixture = Exclude<FixtureKind, 'childTwice'>;

export interface SpikeHooks {
  readonly afterFirst?: (
    answer: unknown,
    config: RunnableConfig,
    request: RunRequest,
  ) => Promise<void>;
}

function unsupported(): GalaxieError {
  return new GalaxieError('unsupported', toErrorInfo('unsupported').message);
}

/** Candidate mapping for scripted top-level graphs only; no shipped adapter imports it. */
export class LangGraphExecutor implements ExecutorAdapter<unknown, unknown> {
  readonly id = 'parallel-spike-langgraph';
  readonly version = '1.0.0';
  readonly features = {
    interrupts: true,
    resume: true,
    checkpoints: true,
    streaming: true,
    subgraphs: false,
  };
  readonly saver: MemorySaver;
  readonly mode: Durability;
  readonly graph: FixtureGraph;
  readonly counts: Counts;
  fault: 'beforeResume' | 'afterCommit' | undefined;
  #active: RunRequest | undefined;

  constructor(kind: TopLevelFixture, saver: MemorySaver, mode: Durability, hooks: SpikeHooks = {}) {
    this.saver = saver;
    this.mode = mode;
    const fixture = createFixture(kind, saver, {
      afterFirst: async (answer, config) => {
        const request = this.#active;
        if (request === undefined) throw unsupported();
        await hooks.afterFirst?.(answer, config, request);
      },
    });
    this.graph = fixture.graph;
    this.counts = fixture.counts;
  }

  async #pauses(
    sessionId: SessionId,
    options?: Pick<RunRequest, 'registerRestoredData'>,
  ): Promise<Pause[]> {
    const config = { configurable: { thread_id: sessionId } };
    const state = await this.graph.getState(config);
    const tuple = await this.saver.getTuple(config);
    const values = committedResumeValues(tuple);
    if (values.length > 0 && options?.registerRestoredData === undefined) throw unsupported();
    for (const value of values) options?.registerRestoredData?.(value);
    let pauses: Pause[];
    try {
      pauses = readPauses(state, tuple);
    } catch {
      throw unsupported();
    }
    for (const pause of pauses) {
      const request = parseInteractionRequest(pause.value);
      if (request !== undefined) continue;
      const surface = parseSurfaceRecord(pause.value);
      if (surface === undefined || pauses.length > 1 || pause.ordinal > 0) throw unsupported();
    }
    return pauses;
  }

  async pending(
    sessionId: SessionId,
    options?: Pick<RunRequest, 'registerRestoredData'>,
  ): Promise<PendingInteraction | undefined> {
    const first = (await this.#pauses(sessionId, options))[0];
    if (first === undefined) return undefined;
    const request = parseInteractionRequest(first.value);
    if (request !== undefined)
      return { interactionId: first.interactionId as InteractionId, ...request };
    const surface = parseSurfaceRecord(first.value);
    if (surface === undefined) throw unsupported();
    return pendingFromSurface(first.interactionId as InteractionId, surface);
  }

  async prepare(): Promise<ExecutorAgent> {
    return {
      pending: (sessionId, options) => this.pending(sessionId, options),
      run: (request) => this.#run(request),
      dispose: async () => {},
    };
  }

  async *#run(request: RunRequest): AsyncGenerator<ExecutorEvent> {
    this.#active = request;
    try {
      const command = request.command;
      let input: Parameters<FixtureGraph['stream']>[0] =
        command.type === 'start' ? (command.input as Parameters<FixtureGraph['stream']>[0]) : null;
      if (command.type === 'resume') {
        const pause = (await this.#pauses(request.sessionId, request))[0];
        if (pause === undefined || pause.interactionId !== command.interactionId)
          throw unsupported();
        if (this.fault === 'beforeResume') {
          this.fault = undefined;
          throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
        }
        input = new Command({
          resume: { [pause.rawId]: { action: command.action, payload: command.payload } },
        });
      }
      const stream = await this.graph.stream(input, {
        configurable: { thread_id: request.sessionId },
        durability: this.mode,
        streamMode: ['values', 'updates'],
        recursionLimit: request.limits.steps,
        signal: request.signal,
      });
      let output: unknown;
      for await (const [mode, data] of stream) {
        yield { type: 'stream', executor: this.id, path: [], mode, data };
        if (mode === 'values') output = data;
      }
      if (command.type === 'resume' && this.fault === 'afterCommit') {
        this.fault = undefined;
        throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
      }
      if (request.signal.aborted) return;
      const interaction = await this.pending(request.sessionId, request);
      if (interaction !== undefined) {
        if (command.type === 'resume' && interaction.interactionId === command.interactionId)
          throw unsupported();
        yield { type: 'interaction', interaction };
      } else yield { type: 'output', output };
    } catch (error) {
      if (!request.signal.aborted)
        yield {
          type: 'error',
          error: toErrorInfo(error instanceof GalaxieError ? error.code : 'executor_error'),
        };
    } finally {
      this.#active = undefined;
    }
  }
}
