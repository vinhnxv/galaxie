// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  GalaxieError,
  type PendingInteraction,
  parseInteractionRequest,
  toErrorInfo,
} from '@galaxie-ai/core';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import {
  type BaseCheckpointSaver,
  interrupt,
  isGraphInterrupt,
  type LangGraphRunnableConfig,
  type StateSnapshot,
} from '@langchain/langgraph';
import { readIdlessPending } from '../../../packages/adapter-langgraph/src/idless.js';
import { requestInteraction } from '../../../packages/adapter-langgraph/src/interaction.js';

export const VALUE_MARKER = 'galaxie.requestInteraction/v1';
export const RESPONSE_SCHEMA = { type: 'null', $comment: VALUE_MARKER } as const;
export type Candidate = 'D1' | 'D2' | 'D3' | 'D4';
const liveMarks = new WeakSet<object>();

export function mark(error: unknown): void {
  if (isGraphInterrupt(error)) {
    liveMarks.add(error);
    for (const pending of error.interrupts) liveMarks.add(pending);
  }
}

export function marked(value: unknown): boolean {
  return typeof value === 'object' && value !== null && liveMarks.has(value);
}

export function candidateHelper(
  candidate: Candidate,
  value: unknown,
  config: LangGraphRunnableConfig,
): unknown {
  if (config.configurable?.['checkpoint_ns'] !== undefined)
    return requestInteraction(value, config);
  const request = parseInteractionRequest(value);
  if (request === undefined)
    throw new GalaxieError('invalid', 'The interaction request is invalid.');
  return AsyncLocalStorageProviderSingleton.runWithConfig(config, () => {
    if (candidate === 'D1') return interrupt({ ...request, __galaxie: VALUE_MARKER });
    if (candidate === 'D2') return interrupt(request, { responseSchema: RESPONSE_SCHEMA });
    try {
      return interrupt(request);
    } catch (error) {
      if (candidate === 'D3') mark(error);
      throw error;
    }
  });
}

export function classifies(
  candidate: Candidate,
  pending: unknown,
  errors: readonly Error[] = [],
): boolean {
  if (typeof pending !== 'object' || pending === null) return false;
  if (candidate === 'D1') {
    const value = 'value' in pending ? pending.value : undefined;
    return (
      typeof value === 'object' &&
      value !== null &&
      '__galaxie' in value &&
      value.__galaxie === VALUE_MARKER
    );
  }
  if (candidate === 'D2')
    return (
      'response_schema' in pending &&
      JSON.stringify(pending.response_schema) === JSON.stringify(RESPONSE_SCHEMA)
    );
  if (candidate === 'D3') return marked(pending) || errors.some(marked);
  return errors.some(
    (error) =>
      isGraphInterrupt(error) &&
      error.name === 'GraphInterrupt' &&
      error.interrupts.length === 1 &&
      Object.hasOwn(error.interrupts[0] as object, 'id'),
  );
}

export async function readCandidate(
  candidate: Candidate,
  tasks: StateSnapshot['tasks'],
  sessionId: string,
  saver: Pick<BaseCheckpointSaver, 'getTuple'>,
  errors: readonly Error[] = [],
  registerRestoredData?: (value: unknown) => void,
): Promise<PendingInteraction> {
  if (!classifies(candidate, tasks[0]?.interrupts[0], errors))
    throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
  return readIdlessPending(tasks, sessionId, saver, registerRestoredData);
}
