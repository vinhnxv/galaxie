// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityPort,
  type ExecutorAdapter,
  type ExecutorEvent,
  GalaxieError,
  type InteractionId,
  isGalaxieError,
  type ModelPort,
  type PendingInteraction,
  parseInteractionRequest,
  parseSurfaceRecord,
  pendingFromSurface,
  type RunRequest,
  toErrorInfo,
} from '@galaxie-ai/core';
import {
  type BaseCheckpointSaver,
  Command,
  GraphRecursionError,
  isGraphInterrupt,
} from '@langchain/langgraph/web';
import { refuseStaticBreakpoints } from './breakpoints.js';
import { adapterError } from './errors.js';
import {
  createHost,
  type LangGraphAgent,
  type LangGraphGraph,
  type LangGraphHost,
  type LangGraphServices,
  validServices,
} from './host.js';
import { readIdlessPending } from './idless.js';
import { installContext } from './interaction.js';
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
    version: '0.1.0',
    features: {
      interrupts: true,
      resume: true,
      checkpoints: true,
      streaming: true,
      subgraphs: true,
    },
    async prepare(agent, services, options) {
      services = services === undefined ? { chatModels: {} } : services;
      if (typeof agent !== 'function' || !validServices(services))
        throw new GalaxieError('invalid', 'The LangGraph factory and services must be valid.');
      installContext();
      let active:
        | {
            readonly capabilities: CapabilityPort;
            readonly models: ModelPort;
            readonly handler: LangGraphTraceHandler;
            readonly signal: AbortSignal;
            readonly payload?: (value: unknown) => string;
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
            const effectScope =
              config?.metadata?.['langgraph_checkpoint_ns'] ??
              config?.configurable?.['checkpoint_ns'];
            return run.capabilities.call(name, input, {
              ...(config?.signal === undefined ? {} : { signal: config.signal }),
              ...(parent === undefined ? {} : { parent }),
              ...(typeof effectScope === 'string' && effectScope.length > 0 ? { effectScope } : {}),
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
      if (typeof graph.getState !== 'function')
        throw new GalaxieError(
          'unsupported',
          'The graph must support checkpoint state inspection.',
        );
      await refuseStaticBreakpoints(graph);
      const bound = graph as LangGraphGraph & { readonly checkpointer?: BaseCheckpointSaver };
      const checkpointer =
        typeof bound.checkpointer?.getTuple === 'function'
          ? bound.checkpointer
          : host.langchain.checkpointer();
      const pending = async (
        sessionId: string,
        options?: Pick<RunRequest, 'registerRestoredData'>,
      ): Promise<PendingInteraction | undefined> => {
        if (graph === undefined)
          throw new GalaxieError('invalid', 'The LangGraph instance was disposed.');
        const state = await graph.getState({ configurable: { thread_id: sessionId } });
        const interrupts = state.tasks.flatMap((task) => task.interrupts);
        if (interrupts.length === 0) return undefined;
        if (interrupts.some(({ id }) => id === undefined))
          return readIdlessPending(
            state.tasks,
            sessionId,
            checkpointer,
            options?.registerRestoredData,
          );
        const ids = new Set(interrupts.map(({ id }) => id));
        const interrupt = interrupts[0];
        if (
          ids.size !== 1 ||
          interrupt === undefined ||
          typeof interrupt.id !== 'string' ||
          !interrupt.id
        )
          throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
        const request = parseInteractionRequest(interrupt.value);
        if (request === undefined) {
          const surface = parseSurfaceRecord(interrupt.value);
          if (surface !== undefined)
            return pendingFromSurface(interrupt.id as InteractionId, surface);
          throw new GalaxieError('invalid', 'The interaction request is invalid.');
        }
        return { interactionId: interrupt.id as InteractionId, ...request };
      };
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          if (graph === undefined)
            throw new GalaxieError('invalid', 'The LangGraph instance was disposed.');
          const handler = new LangGraphTraceHandler(request.trace);
          active = {
            capabilities: request.capabilities,
            models: request.models,
            handler,
            signal: request.signal,
            ...(request.payload === undefined ? {} : { payload: request.payload }),
          };
          let output: unknown;
          let interrupted = false;
          try {
            const command = request.command;
            const idless = command.type === 'resume' && command.interactionId.startsWith('idless:');
            if (idless) {
              const interaction = await pending(request.sessionId, request);
              if (interaction === undefined || interaction.interactionId !== command.interactionId)
                throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
            }
            const input =
              command.type === 'start'
                ? command.input
                : new Command({
                    resume: idless
                      ? { action: command.action, payload: command.payload }
                      : {
                          [command.interactionId]: {
                            action: command.action,
                            payload: command.payload,
                          },
                        },
                  });
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
            if (!request.signal.aborted) {
              if (interrupted) {
                const interaction = await pending(request.sessionId, request);
                if (
                  interaction === undefined ||
                  (command.type === 'resume' &&
                    (interaction.interactionId === command.interactionId ||
                      (!idless && interaction.interactionId.startsWith('idless:'))))
                )
                  throw new GalaxieError('unsupported', toErrorInfo('unsupported').message);
                yield { type: 'interaction', interaction };
              } else yield { type: 'output', output };
            }
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
        pending,
        async dispose() {
          graph = undefined;
          host = undefined;
        },
      };
    },
  };
}
