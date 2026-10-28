// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutorEvent } from './events.js';
import type { InteractionId, RunId, SessionId } from './ids.js';
import type { PendingInteraction } from './interactions.js';

/** What an executor supports, so the runtime never pretends it can pause or resume (brief §7.5). */
export interface ExecutorFeatures {
  readonly interrupts: boolean;
  readonly resume: boolean;
  readonly checkpoints: boolean;
  readonly streaming: boolean;
  readonly subgraphs: boolean;
}

/** Starts a run, or resumes it with a submission taken from the inbox (ADR-0004). */
export type RunCommand =
  | { readonly type: 'start'; readonly input: unknown }
  | { readonly type: 'resume'; readonly interactionId: InteractionId; readonly payload: unknown };

/** One call into an executor. The runtime creates every ID (brief §8.2). */
export interface RunRequest {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly command: RunCommand;
  /** Cooperative cancellation; it cannot preempt synchronous code (brief §6.2). */
  readonly signal: AbortSignal;
}

/** An agent that an executor has prepared (brief §7.5). */
export interface ExecutorAgent {
  /** Streams events until the run waits for input, ends, or the signal aborts. */
  run(request: RunRequest): AsyncIterable<ExecutorEvent>;
  /** Reads the pending interaction from committed state (ADR-0004); undefined when nothing is pending. */
  pending(sessionId: SessionId): Promise<PendingInteraction | undefined>;
  /** Releases what the executor owns (brief §8.3). */
  dispose(): Promise<void>;
}

/**
 * An engine adapter (brief §7.5, ADR-0001). `Agent` and `Services` are executor-specific: for
 * LangGraph, a graph factory and the LangChain models, tools and checkpointer the host injects
 * (brief §7.3). Draft until the Spike A report.
 */
export interface ExecutorAdapter<Agent, Services> {
  readonly id: string;
  readonly version: string;
  readonly features: ExecutorFeatures;
  /** Checks compatibility and builds the agent; rejects with `unsupported` rather than failing later. */
  prepare(agent: Agent, services: Services): Promise<ExecutorAgent>;
}
