// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  AgentTool,
  type Event,
  LlmAgent,
  Runner,
  StreamingMode,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import { failure } from '../../src/errors.js';
import type { HostRegistry } from '../../src/host.js';
import type { RunState } from '../../src/run.js';
import { GalaxieSessionService } from '../../src/session.js';
import { validateAgentTree } from '../../src/validate.js';

export interface PrototypeRegistry {
  readonly trusted: HostRegistry;
  readonly wrappers: WeakMap<object, LlmAgent>;
  readonly pausing: WeakSet<object>;
}

export function validatePrototype(inner: LlmAgent, registry: PrototypeRegistry): void {
  validateAgentTree(inner, registry.trusted);
  const walk = (agent: LlmAgent): void => {
    if (
      agent.inputSchema !== undefined ||
      agent.outputSchema !== undefined ||
      agent.model === undefined
    )
      throw failure('unsupported');
    for (const tool of agent.tools)
      if (registry.pausing.has(tool) || registry.wrappers.has(tool)) throw failure('unsupported');
    for (const child of agent.subAgents) {
      if (child instanceof LlmAgent) walk(child);
    }
  };
  walk(inner);
}

export function pauses(event: Event): boolean {
  return (
    Object.keys(event.actions.requestedToolConfirmations ?? {}).length > 0 ||
    (event.longRunningToolIds?.length ?? 0) > 0
  );
}

export function prototypeTool(
  inner: LlmAgent,
  registry: PrototypeRegistry,
  active: () => RunState,
  observations: { keys: Uint8Array[]; sessions: GalaxieSessionService[] },
): AgentTool {
  class Wrapper extends AgentTool {
    override async runAsync({
      args,
      toolContext,
    }: Parameters<AgentTool['runAsync']>[0]): Promise<unknown> {
      const run = active();
      const signal =
        toolContext.abortSignal === undefined
          ? run.signal
          : AbortSignal.any([run.signal, toolContext.abortSignal]);
      const key = crypto.getRandomValues(new Uint8Array(32));
      const sessions = new GalaxieSessionService();
      observations.keys.push(key);
      observations.sessions.push(sessions);
      const runner = new Runner({
        appName: 'galaxie',
        agent: inner,
        sessionService: sessions,
        plugins: [new ToolCallIntegrityPlugin({ secretKey: key })],
      });
      const sessionId = `agent-tool-${toolContext.functionCallId}`;
      await sessions.createSession({
        appName: 'galaxie',
        userId: 'galaxie',
        sessionId,
        state: toolContext.state.toRecord(),
      });
      let last: Event | undefined;
      try {
        if (typeof args['request'] !== 'string') throw failure('invalid');
        for await (const event of runner.runAsync({
          userId: 'galaxie',
          sessionId,
          abortSignal: signal,
          newMessage: { role: 'user', parts: [{ text: args['request'] }] },
          runConfig: {
            maxLlmCalls: run.steps + 1,
            streamingMode: StreamingMode.NONE,
            pauseOnToolCalls: false,
          },
        })) {
          if (event.errorCode !== undefined) throw run.failure ?? failure('unavailable');
          if (pauses(event)) throw failure('unsupported');
          const delta = Object.fromEntries(
            Object.entries(event.actions.stateDelta ?? {}).filter(
              ([name]) => !name.startsWith('temp:'),
            ),
          );
          toolContext.state.update(delta);
          if (!event.partial) last = event;
        }
        if (run.failure !== undefined) throw run.failure;
        if (signal.aborted) throw failure('cancelled');
        return (last?.content?.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text)
          .filter(Boolean)
          .join('\n');
      } catch (error) {
        throw run.fail(error);
      }
    }
  }
  const wrapper = new Wrapper({ agent: inner });
  registry.trusted.tools.add(wrapper);
  registry.wrappers.set(wrapper, inner);
  return wrapper;
}
