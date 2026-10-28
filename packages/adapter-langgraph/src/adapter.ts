// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type CapabilityPort,
  type ExecutorAdapter,
  type ExecutorEvent,
  GalaxieError,
  isGalaxieError,
  type ModelPort,
  toErrorInfo,
} from '@galaxie/core';
import { GraphRecursionError, isGraphInterrupt } from '@langchain/langgraph/web';
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
    async prepare(agent, services, options) {
      services = services === undefined ? { chatModels: {} } : services;
      if (typeof agent !== 'function' || !validServices(services))
        throw new GalaxieError('invalid', 'The LangGraph factory and services must be valid.');
      let active:
        | {
            readonly capabilities: CapabilityPort;
            readonly models: ModelPort;
            readonly handler: LangGraphTraceHandler;
          }
        | undefined;
      let host: LangGraphHost | undefined = createHost(
        services,
        {
          async call(name, input, config): Promise<unknown> {
            const run = active;
            if (run === undefined)
              throw new GalaxieError('invalid', toErrorInfo('invalid').message);
            const callbacks = config?.callbacks;
            const parentId =
              callbacks !== undefined &&
              !Array.isArray(callbacks) &&
              'getParentRunId' in callbacks &&
              typeof callbacks.getParentRunId === 'function'
                ? callbacks.getParentRunId()
                : undefined;
            const parent = parentId === undefined ? undefined : run.handler.handleFor(parentId);
            return run.capabilities.call(name, input, {
              ...(config?.signal === undefined ? {} : { signal: config.signal }),
              ...(parent === undefined ? {} : { parent }),
            });
          },
        },
        options.models,
        () => active,
      );
      let graph: LangGraphGraph | undefined = agent(host);
      if (typeof graph !== 'object' || graph === null || typeof graph.stream !== 'function')
        throw new GalaxieError('invalid', 'The factory must return a LangGraph stream.');
      if (typeof graph.transform !== 'function')
        throw new GalaxieError(
          'unsupported',
          'The graph must support native runnable transformation.',
        );
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          if (request.command.type === 'resume') {
            yield { type: 'error', error: adapterError('unsupported') };
            return;
          }
          if (graph === undefined)
            throw new GalaxieError('invalid', 'The LangGraph instance was disposed.');
          const handler = new LangGraphTraceHandler(request.trace);
          active = { capabilities: request.capabilities, models: request.models, handler };
          let output: unknown;
          let interrupted = false;
          try {
            const input = request.command.input;
            const source = async function* (): AsyncGenerator<unknown> {
              yield input;
            };
            // LangChain 1.2.20 stream() can reject before resuming an aborted generator.
            // transform() uses the same LangGraph engine and drains its settlement finally block.
            const configured = graph.config?.recursionLimit;
            const recursionLimit =
              typeof configured === 'number' && Number.isInteger(configured) && configured > 0
                ? Math.min(request.limits.steps, configured)
                : request.limits.steps;
            const stream = graph.transform(source(), {
              recursionLimit,
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
            const cause = isGalaxieError(error)
              ? error
              : typeof error === 'object' &&
                  error !== null &&
                  'cause' in error &&
                  isGalaxieError(error.cause)
                ? error.cause
                : undefined;
            if (!request.signal.aborted)
              yield {
                type: 'error',
                error: adapterError(
                  error instanceof GraphRecursionError
                    ? 'budget_exceeded'
                    : (cause?.code ?? (isGraphInterrupt(error) ? 'unsupported' : 'executor_error')),
                  handler.isCredentialFailure(error) ? { name: 'Error' } : error,
                ),
              };
          } finally {
            active = undefined;
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
