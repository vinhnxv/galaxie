// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecutorAdapter,
  type ExecutorAgent,
  type ExecutorEvent,
  GalaxieError,
  type PendingInteraction,
  parseInteractionRequest,
  type RunRequest,
  type SessionId,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';
import type { MemorySaver } from '@langchain/langgraph-checkpoint';
import { type Pause, readBreakpoint } from './breakpoint-reader.js';
import { committedResumeValues } from './checkpoint-reader.js';
import {
  type Counts,
  createFixture,
  type Durability,
  type FixtureGraph,
  type FixtureKind,
  type FixtureOptions,
} from './graphs.js';

function unsupported(): GalaxieError {
  return new GalaxieError('unsupported', toErrorInfo('unsupported').message);
}

export class LangGraphExecutor implements ExecutorAdapter<unknown, unknown> {
  readonly id = 'breakpoint-spike-langgraph';
  readonly version = '1.0.0';
  readonly features = {
    interrupts: true,
    resume: true,
    checkpoints: true,
    streaming: true,
    subgraphs: false,
  };
  readonly graph: FixtureGraph;
  readonly counts: Counts;
  fault: 'beforeResume' | 'afterCommit' | undefined;
  #active: RunRequest | undefined;

  readonly kind: FixtureKind;
  readonly saver: MemorySaver;
  readonly mode: Durability;
  constructor(
    kind: FixtureKind,
    saver: MemorySaver,
    mode: Durability,
    options: FixtureOptions = {},
    hook?: (name: string, config: RunnableConfig, request: RunRequest) => Promise<void>,
  ) {
    this.kind = kind;
    this.saver = saver;
    this.mode = mode;
    const fixture = createFixture(kind, saver, {
      ...options,
      beforeNode: async (name, config) => {
        await options.beforeNode?.(name, config);
        if (this.#active !== undefined) await hook?.(name, config, this.#active);
      },
    });
    this.graph = fixture.graph;
    this.counts = fixture.counts;
  }

  async #pause(
    sessionId: SessionId,
    options?: Pick<RunRequest, 'registerRestoredData'>,
  ): Promise<Pause | undefined> {
    const config = { configurable: { thread_id: sessionId } };
    const snapshot = await this.graph.getState(config);
    const tuple = await this.saver.getTuple(config);
    const values = committedResumeValues(tuple);
    if (values.length > 0 && options?.registerRestoredData === undefined) throw unsupported();
    for (const value of values) options?.registerRestoredData?.(value);
    try {
      const pause = readBreakpoint(this.graph, snapshot, tuple, this.kind === 'strippedNamespace');
      if (pause !== undefined) {
        const { interactionId: _identity, ...value } = pause.interaction;
        if (parseInteractionRequest(value) === undefined) throw unsupported();
      }
      return pause;
    } catch {
      throw unsupported();
    }
  }

  async pending(
    sessionId: SessionId,
    options?: Pick<RunRequest, 'registerRestoredData'>,
  ): Promise<PendingInteraction | undefined> {
    return (await this.#pause(sessionId, options))?.interaction;
  }

  async prepare(): Promise<ExecutorAgent> {
    return {
      pending: (sessionId, options) => this.pending(sessionId, options),
      run: (request) => this.#run(request),
      dispose: async () => {},
    };
  }

  #faultAt(position: 'beforeResume' | 'afterCommit'): void {
    if (this.fault !== position) return;
    this.fault = undefined;
    throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
  }

  async *#run(request: RunRequest): AsyncGenerator<ExecutorEvent> {
    this.#active = request;
    try {
      const command = request.command;
      let input: Parameters<FixtureGraph['stream']>[0] =
        command.type === 'start' ? (command.input as Parameters<FixtureGraph['stream']>[0]) : null;
      if (command.type === 'resume') {
        const pause = await this.#pause(request.sessionId, request);
        if (pause === undefined || pause.interaction.interactionId !== command.interactionId)
          throw unsupported();
        this.#faultAt('beforeResume');
        if (pause.resume === 'null') {
          if (command.action === 'reject') {
            this.#faultAt('afterCommit');
            yield { type: 'error', error: toErrorInfo('denied') };
            return;
          }
          if (command.action !== 'continue') throw unsupported();
          input = null;
        } else {
          const answer = { action: command.action, payload: command.payload };
          input = new Command({
            resume: pause.resume === 'bare' ? answer : { [pause.rawId!]: answer },
          });
        }
      }
      async function* source(): AsyncGenerator<typeof input> {
        yield input;
      }
      let output: unknown;
      const stream = this.graph.transform(source(), {
        configurable: { thread_id: request.sessionId },
        durability: this.mode,
        streamMode: ['values', 'updates'],
        recursionLimit: request.limits.steps,
        signal: request.signal,
      }) as unknown as AsyncIterable<[string, unknown]>;
      for await (const [mode, data] of stream) {
        yield { type: 'stream', executor: this.id, path: [], mode, data };
        if (mode === 'values') output = data;
      }
      if (command.type === 'resume') this.#faultAt('afterCommit');
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
          error: toErrorInfo(error instanceof GalaxieError ? error.code : 'unsupported'),
        };
    } finally {
      this.#active = undefined;
    }
  }
}
