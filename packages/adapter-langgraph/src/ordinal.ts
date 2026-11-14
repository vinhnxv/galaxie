// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  GalaxieError,
  type InteractionId,
  type PendingInteraction,
  parseInteractionRequest,
  parseSurfaceRecord,
  pendingFromSurface,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { BaseCheckpointSaver, StateSnapshot } from '@langchain/langgraph/web';
import { committedResumeValues } from './idless.js';

export async function readOrdinalPending(
  tasks: StateSnapshot['tasks'],
  sessionId: string,
  checkpointer: Pick<BaseCheckpointSaver, 'getTuple'>,
  registerRestoredData?: (value: unknown) => void,
): Promise<{ interaction: PendingInteraction; rawId: string; retryCommittedAnswer: boolean }> {
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
    typeof interrupt.id !== 'string' ||
    !interrupt.id
  )
    return unsupported();
  let tuple: Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>;
  try {
    tuple = await checkpointer.getTuple({ configurable: { thread_id: sessionId } });
  } catch {
    return unsupported();
  }
  if (tuple === undefined) return unsupported();
  const writes = tuple.pendingWrites;
  if (
    writes?.some(
      ([id, channel]) =>
        id === task.id &&
        channel !== '__error__' &&
        channel !== '__error_source_node__' &&
        channel !== '__interrupt__' &&
        channel !== '__resume__',
    )
  )
    return unsupported();
  const count = committedResumeValues(writes, task.id).length;
  const errored = writes?.some(([id, channel]) => id === task.id && channel === '__error__');
  if (errored && count >= 2) return unsupported();
  const restored = committedResumeValues(writes);
  if (restored.length > 0 && registerRestoredData === undefined) return unsupported();
  for (const value of restored) registerRestoredData?.(value);
  if (count > 0 && task.state !== undefined) return unsupported();
  // An error marker cannot distinguish an answered pause from a new question on retry.
  const ordinal = errored ? 0 : count;
  const retryCommittedAnswer = errored === true && count > 0;
  const interactionId = (
    ordinal === 0 ? interrupt.id : `${interrupt.id}:${ordinal}`
  ) as InteractionId;
  const request = parseInteractionRequest(interrupt.value);
  if (request !== undefined)
    return {
      interaction: { interactionId, ...request },
      rawId: interrupt.id,
      retryCommittedAnswer,
    };
  const surface = parseSurfaceRecord(interrupt.value);
  if (surface !== undefined) {
    if (count > 0) return unsupported();
    return {
      interaction: pendingFromSurface(interactionId, surface),
      rawId: interrupt.id,
      retryCommittedAnswer,
    };
  }
  throw new GalaxieError('invalid', 'The interaction request is invalid.');
}
