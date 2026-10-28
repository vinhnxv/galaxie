// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  createLangGraphAdapter,
  type LangGraphGraph,
  STREAM_MODES,
} from '@galaxie/adapter-langgraph';
import {
  type CapabilityBinding,
  type CapabilityName,
  type CapabilityRequest,
  createRuntime,
  defineAgentDefinition,
} from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
  StateSnapshot,
} from '@langchain/langgraph/web';
import * as web from '@langchain/langgraph/web';
import { z } from 'zod';
import { assistantRoles, assistantRouting } from './routing.js';
import { type ModelScript, ScriptedChatModel } from './scripted-chat-model.js';

export type LangGraphModule = typeof import('@langchain/langgraph/web');
export type TranscriptMode = (typeof STREAM_MODES)[number];

export interface ConformanceGraph extends LangGraphGraph {
  getState(config: LangGraphRunnableConfig): Promise<StateSnapshot>;
  getStateHistory(config: LangGraphRunnableConfig): AsyncIterable<StateSnapshot>;
}

export interface ConformanceTools {
  call(name: string, input: unknown, config?: LangGraphRunnableConfig): Promise<unknown>;
}
export interface ConformanceCase {
  readonly capabilities?: Readonly<
    Record<
      CapabilityName,
      CapabilityRequest & { readonly invoke: (input: unknown) => Promise<unknown> }
    >
  >;
  readonly factory: (
    langgraph: LangGraphModule,
    model: BaseChatModel,
    checkpointer: BaseCheckpointSaver,
    tools?: ConformanceTools,
  ) => ConformanceGraph;
  readonly input: unknown;
  readonly script: ModelScript;
}

export interface TranscriptEvent {
  readonly path: readonly string[];
  readonly data: unknown;
}

export interface TranscriptCheckpoint {
  readonly metadata: { readonly step: number | undefined; readonly source: string | undefined };
  readonly next: readonly string[];
  readonly values: unknown;
  readonly parentCheckpointId: unknown;
}

export interface Transcript {
  readonly events: Record<TranscriptMode, TranscriptEvent[]>;
  readonly modes: string[];
  final: unknown;
  state: { readonly values: unknown; readonly next: readonly string[] };
  checkpoints: TranscriptCheckpoint[];
  outcome: { readonly status: 'succeeded' | 'failed'; readonly errorType?: string };
}

function emptyTranscript(): Transcript {
  return {
    events: { values: [], updates: [], messages: [], custom: [] },
    modes: [],
    final: null,
    state: { values: null, next: [] },
    checkpoints: [],
    outcome: { status: 'succeeded' },
  };
}

function append(
  transcript: Transcript,
  path: readonly string[],
  mode: TranscriptMode,
  data: unknown,
): void {
  transcript.events[mode].push({ path, data });
  transcript.modes.push(mode);
}

async function readState(
  transcript: Transcript,
  graph: ConformanceGraph,
  config: LangGraphRunnableConfig,
): Promise<void> {
  const state = await graph.getState(config);
  transcript.state = { values: state.values, next: state.next };
  for await (const checkpoint of graph.getStateHistory(config)) {
    transcript.checkpoints.push({
      metadata: { step: checkpoint.metadata?.step, source: checkpoint.metadata?.source },
      next: checkpoint.next,
      values: checkpoint.values,
      parentCheckpointId: checkpoint.parentConfig?.configurable?.['checkpoint_id'] ?? null,
    });
  }
  transcript.checkpoints.reverse();
}

/** The caller supplies the root namespace only in the native Node test module. */
export async function runNative(
  fixture: ConformanceCase,
  langgraph: LangGraphModule,
): Promise<Transcript> {
  const graph = fixture.factory(
    langgraph,
    new ScriptedChatModel(fixture.script),
    new langgraph.MemorySaver(),
    {
      call: async (name, input) => {
        const capability = fixture.capabilities?.[name as CapabilityName];
        if (capability === undefined) throw new Error('The native fixture capability is missing.');
        return capability.invoke(input);
      },
    },
  );
  const config = { configurable: { thread_id: crypto.randomUUID() } };
  const transcript = emptyTranscript();
  let final: unknown = null;
  try {
    const stream = await graph.stream(fixture.input, {
      ...config,
      streamMode: [...STREAM_MODES],
      subgraphs: true,
      signal: new AbortController().signal,
    });
    for await (const chunk of stream) {
      const [path, mode, data] = chunk as [string[], TranscriptMode, unknown];
      append(transcript, path, mode, data);
      if (path.length === 0 && mode === 'values') final = data;
    }
    transcript.final = final;
  } catch (error) {
    transcript.outcome = { status: 'failed', errorType: (error as Error).name };
  }
  await readState(transcript, graph, config);
  return transcript;
}

const definition = defineAgentDefinition({
  id: 'conformance/graph',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.unknown(),
  models: assistantRoles,
});

export async function runGalaxie(fixture: ConformanceCase): Promise<Transcript> {
  const saver = new web.MemorySaver();
  let graph: ConformanceGraph | undefined;
  const runtime = createRuntime({ appId: 'conformance', executors: [createLangGraphAdapter()] });
  const requests = Object.fromEntries(
    Object.entries(fixture.capabilities ?? {}).map(([name, capability]) => [
      name,
      { input: capability.input, output: capability.output, kind: capability.kind },
    ]),
  );
  const bindings: Record<string, CapabilityBinding> = Object.fromEntries(
    Object.entries(fixture.capabilities ?? {}).map(([name, capability]) => [
      name,
      {
        kind: capability.kind,
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 1,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        invoke: capability.invoke,
      },
    ]),
  );
  const instance = await runtime.create(
    { ...definition, capabilities: { required: requests } },
    {
      bindings,
      models: assistantRouting(),
      principalScope: 'conformance',
      services: {
        chatModels: { assistant: new ScriptedChatModel(fixture.script) },
        checkpointer: saver,
      },
      agent: (host) => {
        graph = fixture.factory(
          web,
          host.langchain.chatModel('assistant'),
          host.langchain.checkpointer(),
          host.capabilities,
        );
        return graph;
      },
    },
  );
  const transcript = emptyTranscript();
  try {
    await instance.prepare();
    const { runId } = await instance.start(fixture.input);
    for await (const event of instance.events(runId)) {
      if (event.type === 'stream')
        append(transcript, event.path, event.mode as TranscriptMode, event.data);
      else if (event.type === 'output') transcript.final = event.output;
      else if (event.type === 'error')
        transcript.outcome = {
          status: 'failed',
          ...(event.error.type === undefined ? {} : { errorType: event.error.type }),
        };
    }
  } finally {
    // Public terminal events precede executor settlement; disposal waits for checkpoint writes.
    await runtime.dispose();
  }
  if (graph === undefined) throw new Error('The conformance graph was not prepared.');
  const threadId = Object.keys(saver.storage)[0];
  await readState(transcript, graph, { configurable: { thread_id: threadId } });
  return transcript;
}

export function galaxieLane(): 'galaxie-node' | 'galaxie-chromium' {
  return typeof window === 'undefined' ? 'galaxie-node' : 'galaxie-chromium';
}
