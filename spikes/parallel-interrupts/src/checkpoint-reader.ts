// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunnableConfig } from '@langchain/core/runnables';
import type { StateSnapshot } from '@langchain/langgraph';
import { type CheckpointTuple, MemorySaver } from '@langchain/langgraph-checkpoint';

export interface Pause {
  readonly taskId: string;
  readonly taskOrder: number;
  readonly rawId: string;
  readonly ordinal: number;
  readonly interactionId: string;
  readonly value: unknown;
  readonly resumeValues: readonly unknown[];
}

// This is the succeeded-task test in LangGraph 1.5.1's _reapplyWritesToSucceededNodes.
const incompleteChannels = new Set([
  '__error__',
  '__error_source_node__',
  '__interrupt__',
  '__resume__',
]);

export function taskDone(tuple: CheckpointTuple | undefined, taskId: string): boolean {
  return (
    tuple?.pendingWrites?.some(
      ([id, channel]) => id === taskId && !incompleteChannels.has(channel),
    ) ?? false
  );
}

export function taskResumeValues(tuple: CheckpointTuple | undefined, taskId: string): unknown[] {
  return (tuple?.pendingWrites ?? [])
    .filter(([id, channel]) => id === taskId && channel === '__resume__')
    .flatMap(([, , values]) => (Array.isArray(values) ? values : [values]));
}

export function committedResumeValues(tuple: CheckpointTuple | undefined): unknown[] {
  return (tuple?.pendingWrites ?? [])
    .filter(([, channel]) => channel === '__resume__')
    .flatMap(([, , values]) => (Array.isArray(values) ? values : [values]));
}

export function readPauses(snapshot: StateSnapshot, tuple: CheckpointTuple | undefined): Pause[] {
  const pauses: Pause[] = [];
  for (const [taskOrder, task] of snapshot.tasks.entries()) {
    if (taskDone(tuple, task.id)) continue;
    const resumeValues = taskResumeValues(tuple, task.id);
    for (const pause of task.interrupts) {
      if (typeof pause.id !== 'string' || pause.id.length === 0)
        throw new Error('Unsupported interrupt identity.');
      const ordinal = resumeValues.length;
      pauses.push({
        taskId: task.id,
        taskOrder,
        rawId: pause.id,
        ordinal,
        interactionId: ordinal === 0 ? pause.id : `${pause.id}:${ordinal}`,
        value: pause.value,
        resumeValues,
      });
    }
  }
  return pauses.sort(
    (left, right) =>
      left.taskOrder - right.taskOrder ||
      left.rawId.localeCompare(right.rawId) ||
      left.ordinal - right.ordinal,
  );
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
