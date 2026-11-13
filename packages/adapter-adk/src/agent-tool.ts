// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type CapabilityPort, capabilityBindingPolicy } from '@galaxie-ai/core';
import {
  AgentTool,
  type BaseAgent,
  type Event,
  isFinalResponse,
  Runner,
  StreamingMode,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import { failure } from './errors.js';
import { type AdkHost, hostInternals } from './host.js';
import { GalaxieSessionService } from './session.js';
import { validatedInnerCapabilities } from './validate.js';

/** Admission always uses the broker-created port, never author-supplied tool flags. */
export function admitCapabilities(names: readonly string[], port: CapabilityPort): void {
  for (const name of names) {
    const policy = capabilityBindingPolicy(port, name);
    if (policy === undefined || policy.kind !== 'read' || policy.approval !== 'none')
      throw failure('unsupported');
  }
}

export function innerPause(event: Event): boolean {
  return (
    Object.keys(event.actions?.requestedToolConfirmations ?? {}).length > 0 ||
    (event.longRunningToolIds?.length ?? 0) > 0
  );
}

class IsolatedAgentTool extends AgentTool {
  readonly #host: AdkHost;
  readonly #inner: BaseAgent;

  constructor(host: AdkHost, inner: BaseAgent) {
    super({ agent: inner });
    this.#host = host;
    this.#inner = inner;
  }

  override async runAsync({
    args,
    toolContext,
  }: Parameters<AgentTool['runAsync']>[0]): Promise<unknown> {
    const { registry, active } = hostInternals(this.#host);
    const run = active();
    if (run === undefined) throw failure('invalid');
    try {
      if (run.failure !== undefined) throw run.failure;
      admitCapabilities(validatedInnerCapabilities(this.#inner, registry, true), run.capabilities);
      if (typeof args['request'] !== 'string') throw failure('invalid');
      const sessions = new GalaxieSessionService();
      const runner = new Runner({
        appName: 'galaxie',
        agent: this.#inner,
        sessionService: sessions,
        plugins: [
          new ToolCallIntegrityPlugin({ secretKey: crypto.getRandomValues(new Uint8Array(32)) }),
        ],
      });
      const sessionId = toolContext.functionCallId;
      if (sessionId === undefined) throw failure('invalid');
      await sessions.createSession({
        appName: 'galaxie',
        userId: 'galaxie',
        sessionId,
        state: toolContext.state.toRecord(),
      });
      const signal =
        toolContext.abortSignal === undefined
          ? run.signal
          : AbortSignal.any([run.signal, toolContext.abortSignal]);
      let text = '';
      for await (const event of runner.runAsync({
        userId: 'galaxie',
        sessionId,
        newMessage: { role: 'user', parts: [{ text: args['request'] }] },
        runConfig: {
          maxLlmCalls: run.steps + 1,
          streamingMode: StreamingMode.NONE,
          pauseOnToolCalls: false,
        },
        abortSignal: signal,
      })) {
        if (innerPause(event)) throw failure('unsupported');
        if (event.errorCode !== undefined) throw run.failure ?? failure('unavailable');
        if (run.failure !== undefined) throw run.failure;
        if (event.partial === true) continue;
        for (const [key, value] of Object.entries(event.actions?.stateDelta ?? {}))
          if (!key.startsWith('temp:')) toolContext.state.set(key, value);
        if (isFinalResponse(event))
          text = (event.content?.parts ?? [])
            .filter((part) => part.thought !== true)
            .map((part) => part.text ?? '')
            .join('');
      }
      if (run.failure !== undefined) throw run.failure;
      if (signal.aborted) throw failure('cancelled');
      return text;
    } catch (error) {
      throw run.fail(error);
    }
  }
}

/** Wraps a registered-model agent in an isolated, read-only inner run. */
export function agentTool(host: AdkHost, innerAgent: BaseAgent): AgentTool {
  const { registry } = hostInternals(host);
  const tool = new IsolatedAgentTool(host, innerAgent);
  registry.tools.add(tool);
  registry.wrappers.set(tool, innerAgent);
  return tool;
}
