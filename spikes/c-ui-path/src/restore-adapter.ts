// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Spike-only model of M3 restore. Never copy this shim into packages.
import {
  createLangGraphAdapter,
  type LangGraphAgent,
  type LangGraphServices,
} from '@galaxie/adapter-langgraph';
import type { ExecutorAdapter, ExecutorEvent, SessionId } from '@galaxie/core';
import { THREAD_KEY } from './session-saver.js';

export function restoreAdapter(): ExecutorAdapter<LangGraphAgent, LangGraphServices> {
  const adapter = createLangGraphAdapter();
  return {
    ...adapter,
    async prepare(agent, services, options) {
      const inner = await adapter.prepare(agent, services, options);
      let thread = sessionStorage.getItem(THREAD_KEY) as SessionId | null;
      return {
        pending: (sessionId) => inner.pending(thread ?? sessionId),
        dispose: () => inner.dispose(),
        async *run(request): AsyncGenerator<ExecutorEvent> {
          if (thread === null) {
            thread = request.sessionId;
            sessionStorage.setItem(THREAD_KEY, thread);
          }
          if (
            request.command.type === 'start' &&
            typeof request.command.input === 'object' &&
            request.command.input !== null &&
            'restore' in request.command.input &&
            request.command.input.restore === true
          ) {
            const interaction = await inner.pending(thread);
            if (interaction) yield { type: 'interaction', interaction };
            else
              yield {
                type: 'error',
                error: { code: 'unsupported', message: 'No pending interaction to restore.' },
              };
            return;
          }
          for await (const event of inner.run({ ...request, sessionId: thread })) {
            // The adapter uses the final values chunk as output; journal only the public score.
            if (event.type === 'output') {
              const output = event.output;
              yield {
                type: 'output',
                output: {
                  score:
                    typeof output === 'object' && output !== null && 'score' in output
                      ? output.score
                      : undefined,
                },
              };
            } else yield event;
          }
        },
      };
    },
  };
}
