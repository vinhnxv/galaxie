// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  GalaxieError,
  type InteractionId,
  type PendingInteraction,
  parseInteractionRequest,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { BaseCheckpointSaver, StateSnapshot } from '@langchain/langgraph/web';

type Writes = NonNullable<Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>>['pendingWrites'];

export function committedResumeValues(writes: Writes, taskId?: string): unknown[] {
  return (writes ?? []).flatMap(([id, channel, value]) =>
    channel === '__resume__' && (taskId === undefined || id === taskId)
      ? Array.isArray(value)
        ? value
        : [value]
      : [],
  );
}

export async function readIdlessPending(
  tasks: StateSnapshot['tasks'],
  sessionId: string,
  checkpointer: Pick<BaseCheckpointSaver, 'getTuple'>,
  registerRestoredData?: (value: unknown) => void,
): Promise<PendingInteraction> {
  const unsupported = (): never => {
    throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
  };
  const interrupting = tasks.filter((task) => task.interrupts.length > 0);
  const task = interrupting[0];
  const interrupt = task?.interrupts[0];
  if (
    interrupting.length !== 1 ||
    task === undefined ||
    task.interrupts.length !== 1 ||
    interrupt === undefined ||
    interrupt.id !== undefined ||
    task.state !== undefined
  )
    return unsupported();
  const request = parseInteractionRequest(interrupt.value);
  if (request === undefined) return unsupported();
  let tuple: Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>;
  try {
    tuple = await checkpointer.getTuple({ configurable: { thread_id: sessionId } });
  } catch {
    return unsupported();
  }
  const writes = tuple?.pendingWrites;
  if (!writes?.some(([id, channel]) => id === task.id && channel === '__interrupt__'))
    return unsupported();
  for (const sibling of tasks) {
    if (
      sibling.id !== task.id &&
      !writes.some(
        ([id, channel]) =>
          id === sibling.id &&
          channel !== '__error__' &&
          channel !== '__interrupt__' &&
          channel !== '__resume__',
      )
    )
      return unsupported();
  }
  const count = committedResumeValues(writes, task.id).length;
  // An errored node already consumed this answer; replay must keep the accepted identity.
  if (count !== 0 && !(count === 1 && task.error !== undefined)) return unsupported();
  const restored = committedResumeValues(writes);
  if (restored.length > 0 && registerRestoredData === undefined) return unsupported();
  for (const value of restored) registerRestoredData?.(value);
  return { interactionId: `idless:${task.id}:0` as InteractionId, ...request };
}
