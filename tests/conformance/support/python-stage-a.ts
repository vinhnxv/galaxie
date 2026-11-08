// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ExecutorEvent, InteractionId, RunRequest } from '@galaxie-ai/core';
import {
  createPyodideAdapter,
  type PyodideAdapterOptions,
  type PyodideAgent,
} from '../../../packages/adapter-pyodide/src/adapter.js';

export const pythonStageACases = [
  'interrupt-resume',
  'interrupt-sequence',
  'interrupt-durability-sync',
  'interrupt-durability-exit',
] as const;

export interface PythonCaseTranscript {
  readonly pauses: { interrupts: { id: string; value: unknown }[] }[];
  final: unknown;
  emptyPending: boolean;
  stablePending: boolean;
  repeated: ExecutorEvent[];
}

export async function executePythonCase(
  options: PyodideAdapterOptions,
  agent: PyodideAgent,
  name: string,
  input: unknown,
  resumes: readonly { readonly action: string; readonly payload: unknown }[],
): Promise<PythonCaseTranscript> {
  if (!(pythonStageACases as readonly string[]).includes(name))
    throw new Error('The conformance case is unknown.');
  const executor = await createPyodideAdapter(options).prepare(
    agent,
    { chatModels: {} },
    { signal: new AbortController().signal },
  );
  const transcript: PythonCaseTranscript = {
    pauses: [],
    final: undefined,
    emptyPending: false,
    stablePending: true,
    repeated: [],
  };
  const base: RunRequest = {
    runId: 'python-conformance' as RunRequest['runId'],
    sessionId: 'python-conformance' as RunRequest['sessionId'],
    command: { type: 'start', input },
    signal: new AbortController().signal,
    limits: { steps: 25 },
    trace: {} as RunRequest['trace'],
    models: {
      async begin() {
        throw new Error('Unexpected model call.');
      },
    },
    capabilities: {
      async call() {
        throw new Error('Unexpected capability call.');
      },
    },
  };
  let command = base.command;
  let lastId: InteractionId | undefined;
  try {
    transcript.emptyPending = (await executor.pending(base.sessionId)) === undefined;
    for (;;) {
      let paused = false;
      for await (const event of executor.run({ ...base, command })) {
        if (event.type === 'interaction') {
          const { interactionId, ...value } = event.interaction;
          transcript.stablePending &&=
            JSON.stringify(await executor.pending(base.sessionId)) ===
            JSON.stringify(event.interaction);
          transcript.pauses.push({
            interrupts: [{ id: `<interrupt:${transcript.pauses.length + 1}>`, value }],
          });
          if (lastId === interactionId) throw new Error('An answered interaction paused again.');
          lastId = interactionId;
          paused = true;
        } else if (event.type === 'output') transcript.final = event.output;
        else if (event.type === 'error') throw new Error(event.error.message);
        else if (event.type !== 'stream') throw new Error('Unexpected executor event.');
      }
      if (!paused) break;
      const answer = resumes[transcript.pauses.length - 1];
      if (!answer || !lastId) throw new Error('The conformance answer is missing.');
      command = { type: 'resume', interactionId: lastId, ...answer };
    }
    transcript.emptyPending &&= (await executor.pending(base.sessionId)) === undefined;
    for await (const event of executor.run({ ...base, command })) transcript.repeated.push(event);
    return transcript;
  } finally {
    await executor.dispose();
  }
}
