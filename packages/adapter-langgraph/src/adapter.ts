// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ExecutorAdapter, type ExecutorEvent, GalaxieError } from '@galaxie/core';
import { isGraphInterrupt } from '@langchain/langgraph/web';
import { adapterError } from './errors.js';
import {
  createHost,
  type LangGraphAgent,
  type LangGraphGraph,
  type LangGraphHost,
  type LangGraphServices,
  validServices,
} from './host.js';
import { LangGraphTraceHandler } from './trace-handler.js';

export const STREAM_MODES: readonly ['values', 'updates', 'messages', 'custom'] = [
  'values',
  'updates',
  'messages',
  'custom',
];

export function createLangGraphAdapter(): ExecutorAdapter<LangGraphAgent, LangGraphServices> {
  return {
    id: 'langgraph-js',
    version: '0.0.0',
    features: {
      interrupts: false,
      resume: false,
      checkpoints: false,
      streaming: true,
      subgraphs: true,
    },
    async prepare(agent, services, _options) {
      services = services === undefined ? { chatModels: {} } : services;
      if (typeof agent !== 'function' || !validServices(services))
        throw new GalaxieError('invalid', 'The LangGraph factory and services must be valid.');
      let host: LangGraphHost | undefined = createHost(services);
      let graph: LangGraphGraph | undefined = agent(host);
      if (typeof graph !== 'object' || graph === null || typeof graph.stream !== 'function')
        throw new GalaxieError('invalid', 'The factory must return a LangGraph stream.');
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          if (request.command.type === 'resume') {
            yield { type: 'error', error: adapterError('unsupported') };
            return;
          }
          if (graph === undefined)
            throw new GalaxieError('invalid', 'The LangGraph instance was disposed.');
          const handler = new LangGraphTraceHandler(request.trace);
          let output: unknown;
          let interrupted = false;
          try {
            const stream = await graph.stream(request.command.input, {
              streamMode: [...STREAM_MODES],
              subgraphs: true,
              signal: request.signal,
              callbacks: [handler],
              configurable: { thread_id: request.sessionId },
            });
            for await (const chunk of stream) {
              const [path, mode, data] = chunk as [string[], string, unknown];
              yield { type: 'stream', executor: 'langgraph-js', path, mode, data };
              if (path.length === 0 && mode === 'values') output = data;
              if (
                path.length === 0 &&
                mode === 'updates' &&
                typeof data === 'object' &&
                data !== null &&
                '__interrupt__' in data
              )
                interrupted = true;
            }
            if (!request.signal.aborted)
              yield interrupted
                ? { type: 'error', error: adapterError('unsupported') }
                : { type: 'output', output };
          } catch (error) {
            if (!request.signal.aborted)
              yield {
                type: 'error',
                error: adapterError(
                  isGraphInterrupt(error) ? 'unsupported' : 'executor_error',
                  error,
                ),
              };
          } finally {
            await handler.settled();
          }
        },
        pending: async () => undefined,
        async dispose() {
          graph = undefined;
          host = undefined;
        },
      };
    },
  };
}
