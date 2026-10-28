// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { CapabilityPort } from './capabilities.js';
import type { ExecutorEvent } from './events.js';
import type { InteractionId, RunId, SessionId } from './ids.js';
import type { PendingInteraction } from './interactions.js';
import type { RunTrace } from './trace.js';

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
  readonly trace: RunTrace;
  readonly capabilities: CapabilityPort;
  readonly limits: { readonly steps: number };
}

/** An agent that an executor has prepared (brief §7.5). */
export interface ExecutorAgent {
  /**
   * Completes only when the engine has settled, including checkpoint writes after an abort.
   * Core keeps draining after cancellation and never calls the iterator's return().
   * Core alone bounds settlement waits; executors must not add their own timeout.
   */
  run(request: RunRequest): AsyncIterable<ExecutorEvent>;
  /** Reads the pending interaction from committed state (ADR-0004); undefined when nothing is pending. */
  pending(sessionId: SessionId): Promise<PendingInteraction | undefined>;
  /** Releases what the executor owns (brief §8.3). */
  dispose(): Promise<void>;
}

/**
 * An engine adapter (brief §7.5, ADR-0001). `Agent` and `Services` are executor-specific: for
 * LangGraph, a graph factory and the LangChain models, tools and checkpointer the host injects
 * (brief §7.3).
 */
export interface ExecutorAdapter<Agent, Services> {
  readonly id: string;
  readonly version: string;
  readonly features: ExecutorFeatures;
  /** Malformed agent/services reject with `invalid`; incompatible versions/features with `unsupported`. */
  prepare(
    agent: Agent,
    services: Services,
    options: { readonly signal: AbortSignal },
  ): Promise<ExecutorAgent>;
}
