// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunnableConfig } from '@langchain/core/runnables';
import { type CheckpointTuple, MemorySaver } from '@langchain/langgraph-checkpoint';

export function committedResumeValues(tuple: CheckpointTuple | undefined): unknown[] {
  return (tuple?.pendingWrites ?? [])
    .filter(([, channel]) => channel === '__resume__')
    .flatMap(([, , values]) => (Array.isArray(values) ? values : [values]));
}

export function reopenSaver(saver: MemorySaver, reverseWrites = false): MemorySaver {
  const reopened = new MemorySaver();
  reopened.storage = structuredClone(saver.storage);
  reopened.writes = structuredClone(saver.writes);
  if (reverseWrites) {
    const getTuple = reopened.getTuple.bind(reopened);
    reopened.getTuple = async (config: RunnableConfig): Promise<CheckpointTuple | undefined> => {
      const tuple = await getTuple(config);
      return tuple === undefined
        ? undefined
        : { ...tuple, pendingWrites: [...(tuple.pendingWrites ?? [])].reverse() };
    };
  }
  return reopened;
}
