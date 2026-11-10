// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecutorAdapter,
  type ExecutorAgent,
  type ExecutorEvent,
  GalaxieError,
  type InteractionId,
  type InteractionRequest,
  type PendingInteraction,
  parseInteractionRequest,
  parseSurfaceRecord,
  pendingFromSurface,
  type RunRequest,
  toErrorInfo,
  type ViewRevision,
} from '@galaxie-ai/core';

export interface FakeTask {
  readonly rawId: string;
  readonly order: number;
  readonly requests: readonly unknown[];
  readonly answers: unknown[];
}

export interface FakeState {
  readonly tasks: FakeTask[];
  readonly applied: Array<{ id: string; payload: unknown }>;
  readonly prefixes: Record<string, number>;
  starts: number;
  reverseOrder: boolean;
}

export interface CommitGate {
  readonly entered: Promise<void>;
  release(): void;
  crash(): void;
}

interface ArmedGate {
  readonly phase: 'beforeCommit' | 'afterCommit';
  readonly enter: () => void;
  readonly outcome: Promise<boolean>;
}

export function question(name: string): InteractionRequest {
  return {
    surfaceId: 'main',
    viewRevision: `revision-${name}` as ViewRevision,
    component: 'spike.Question/v1',
    props: { question: name },
  };
}

export function fakeState(shape: 'twice' | number): FakeState {
  return {
    tasks:
      shape === 'twice'
        ? [{ rawId: 'r', order: 0, requests: [question('first'), question('second')], answers: [] }]
        : Array.from({ length: shape }, (_, index) => ({
            rawId: String.fromCharCode(97 + index),
            order: index,
            requests: [question(`branch-${index}`)],
            answers: [],
          })),
    applied: [],
    prefixes: {},
    starts: 0,
    reverseOrder: false,
  };
}

function pauseId(task: FakeTask): InteractionId {
  return `${task.rawId}${task.answers.length === 0 ? '' : `:${task.answers.length}`}` as InteractionId;
}

/** A checkpoint model only; it deliberately has no memory of the last publication. */
export class FakeEngine implements ExecutorAdapter<unknown, unknown> {
  readonly id = 'parallel-spike-fake';
  readonly version = '1.0.0';
  readonly features = {
    interrupts: true,
    resume: true,
    checkpoints: true,
    streaming: true,
    subgraphs: false,
  };
  readonly state: FakeState;
  readonly prefix?: (task: FakeTask, request: RunRequest) => Promise<void>;
  #gate: ArmedGate | undefined;

  constructor(state: FakeState, prefix?: (task: FakeTask, request: RunRequest) => Promise<void>) {
    this.state = state;
    if (prefix !== undefined) this.prefix = prefix;
  }

  gate(phase: ArmedGate['phase']): CommitGate {
    let entered!: () => void;
    let finish!: (commit: boolean) => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const outcome = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    this.#gate = { phase, enter: entered, outcome };
    return { entered: enteredPromise, release: () => finish(true), crash: () => finish(false) };
  }

  async #at(phase: ArmedGate['phase']): Promise<boolean> {
    const gate = this.#gate;
    if (gate === undefined || gate.phase !== phase) return true;
    this.#gate = undefined;
    gate.enter();
    return gate.outcome;
  }

  pending(): PendingInteraction | undefined {
    const tasks = this.state.tasks
      .filter((task) => task.answers.length < task.requests.length)
      .sort((left, right) => left.order - right.order || left.rawId.localeCompare(right.rawId));
    if (this.state.reverseOrder) tasks.reverse();
    for (const task of tasks) {
      const surface = parseSurfaceRecord(task.requests[task.answers.length]);
      if (surface !== undefined && (tasks.length > 1 || task.answers.length > 0))
        throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
    }
    const first = tasks[0];
    if (first === undefined) return undefined;
    const value = first.requests[first.answers.length];
    const request = parseInteractionRequest(value);
    if (request !== undefined) return { interactionId: pauseId(first), ...request };
    const surface = parseSurfaceRecord(value);
    if (surface !== undefined) return pendingFromSurface(pauseId(first), surface);
    throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
  }

  async prepare(): Promise<ExecutorAgent> {
    return {
      pending: async () => this.pending(),
      dispose: async () => {},
      run: (request) => this.#run(request),
    };
  }

  async *#run(request: RunRequest): AsyncGenerator<ExecutorEvent> {
    this.state.starts++;
    try {
      for (const task of this.state.tasks) {
        if (task.answers.length === task.requests.length) continue;
        this.state.prefixes[task.rawId] = (this.state.prefixes[task.rawId] ?? 0) + 1;
        await this.prefix?.(task, request);
      }
      if (request.command.type === 'resume') {
        const command = request.command;
        const task = this.state.tasks.find((entry) => pauseId(entry) === command.interactionId);
        if (task === undefined || task.answers.length === task.requests.length)
          throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
        if (!(await this.#at('beforeCommit'))) return;
        task.answers.push(structuredClone(command.payload));
        this.state.applied.push({
          id: command.interactionId,
          payload: structuredClone(command.payload),
        });
        if (!(await this.#at('afterCommit'))) return;
      }
      const interaction = this.pending();
      if (interaction !== undefined) yield { type: 'interaction', interaction };
      else yield { type: 'output', output: this.state.applied };
    } catch (error) {
      if (error instanceof GalaxieError) yield { type: 'error', error: toErrorInfo(error.code) };
      else throw error;
    }
  }
}
