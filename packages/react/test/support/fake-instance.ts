// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AgentInstance,
  type AgentSnapshot,
  type DispatchReceipt,
  type InstanceId,
  type InteractionId,
  type PendingInteraction,
  type RunEvent,
  type RunId,
  toErrorInfo,
  type ViewRevision,
} from '@galaxie/core';
import { type Mock, vi } from 'vitest';

export function interaction(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    interactionId: 'interaction-1' as InteractionId,
    surfaceId: 'lesson-main',
    viewRevision: 'r1' as ViewRevision,
    component: 'tests.Question/v1',
    props: { title: 'Question' },
    ...overrides,
  };
}

export class FakeInstance implements AgentInstance<unknown, unknown> {
  readonly instanceId: InstanceId;
  private snapshot: AgentSnapshot<unknown>;
  private readonly listeners: Set<() => void> = new Set();
  subscribeCalls: number = 0;
  unsubscribeCalls: number = 0;
  readonly prepare: Mock<AgentInstance<unknown, unknown>['prepare']> = vi.fn(async () => {});
  readonly start: Mock<AgentInstance<unknown, unknown>['start']> = vi.fn(async () => ({
    runId: 'unused' as RunId,
  }));
  readonly cancel: Mock<AgentInstance<unknown, unknown>['cancel']> = vi.fn(async (runId) => ({
    runId,
    status: 'cancelled' as const,
  }));
  readonly dispose: Mock<AgentInstance<unknown, unknown>['dispose']> = vi.fn(async () => {});
  readonly events: Mock<AgentInstance<unknown, unknown>['events']> = vi.fn(
    async function* (): AsyncGenerator<RunEvent> {},
  );
  readonly dispatch: Mock<AgentInstance<unknown, unknown>['dispatch']> = vi.fn(async (event) => {
    const run = this.snapshot.run;
    const pending = run?.pending;
    if (
      event.instanceId !== this.instanceId ||
      event.runId !== run?.runId ||
      pending === undefined ||
      event.interactionId !== pending.interactionId ||
      event.surfaceId !== pending.surfaceId ||
      event.viewRevision !== pending.viewRevision
    )
      return { status: 'rejected', error: toErrorInfo('stale') };
    return { status: 'accepted', interactionId: pending.interactionId };
  });
  readonly getSnapshot: Mock<AgentInstance<unknown, unknown>['getSnapshot']> = vi.fn(
    () => this.snapshot,
  );
  readonly subscribe: Mock<AgentInstance<unknown, unknown>['subscribe']> = vi.fn((listener) => {
    this.subscribeCalls++;
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCalls++;
      this.listeners.delete(listener);
    };
  });

  constructor(id = 'instance-1') {
    this.instanceId = id as InstanceId;
    this.snapshot = Object.freeze({ instanceId: this.instanceId, state: 'ready' });
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  setSnapshot(snapshot: AgentSnapshot<unknown>): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  setPending(pending: PendingInteraction, runId = 'run-1'): void {
    this.setSnapshot({
      instanceId: this.instanceId,
      state: 'ready',
      run: { runId: runId as RunId, status: 'waiting_input', labels: [], pending },
    });
  }
}

export function rejected(code: 'invalid' | 'stale' = 'invalid'): DispatchReceipt {
  return { status: 'rejected', error: toErrorInfo(code) };
}
