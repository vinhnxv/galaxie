// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutorAdapter, ExecutorEvent, PendingInteraction } from '@galaxie/core';
import {
  type BaseAgent,
  isFinalResponse,
  LlmAgent,
  Runner,
  StreamingMode,
  setLogger,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import { adapterError, failure } from './errors.js';
import { type AdkAgent, type AdkServices, createHost, validServices } from './host.js';
import { RunState, toGalaxieError } from './run.js';
import { ensureAdkRuntimeEnv } from './runtime-shim.js';
import { GalaxieSessionService } from './session.js';
import { validateAgentTree } from './validate.js';

const APP_NAME = 'galaxie';
const USER_ID = 'galaxie';

const SILENT_LOGGER = {
  log(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  setLogLevel(): void {},
};

function promptOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const prompt: unknown = Reflect.get(input, 'prompt');
  return typeof prompt === 'string' && prompt.length > 0 ? prompt : undefined;
}

/** The value a finished conversation returns: the structured output key if set, else the text. */
interface FinalResponse {
  readonly author: string | undefined;
  readonly text: string;
  readonly delta: unknown;
}

function outputOf(root: BaseAgent, last: FinalResponse): unknown {
  const author = last.author === undefined ? undefined : findAgent(root, last.author);
  const key = author instanceof LlmAgent ? author.outputKey : undefined;
  if (
    key !== undefined &&
    typeof last.delta === 'object' &&
    last.delta !== null &&
    key in last.delta
  )
    return Reflect.get(last.delta, key);
  return last.text;
}

function findAgent(root: BaseAgent, name: string): BaseAgent | undefined {
  return root.name === name ? root : root.findSubAgent(name);
}

export function createAdkAdapter(): ExecutorAdapter<AdkAgent, AdkServices> {
  return {
    id: 'adk-js',
    version: '0.0.0',
    features: {
      interrupts: false,
      resume: false,
      checkpoints: false,
      streaming: false,
      subgraphs: false,
    },
    async prepare(agent, services, options) {
      services = services === undefined ? { chatModels: {} } : services;
      if (typeof agent !== 'function' || !validServices(services)) throw failure('invalid');
      ensureAdkRuntimeEnv();
      setLogger(SILENT_LOGGER);
      let active: RunState | undefined;
      let conversation = '';
      const { host, registry } = createHost(
        services,
        options.models,
        () => active,
        () => conversation,
      );
      const root: unknown = agent(host);
      validateAgentTree(root, registry);
      const sessions = new GalaxieSessionService();
      let runner: Runner | undefined = new Runner({
        appName: APP_NAME,
        agent: root as BaseAgent,
        plugins: [
          new ToolCallIntegrityPlugin({ secretKey: crypto.getRandomValues(new Uint8Array(32)) }),
        ],
        sessionService: sessions,
      });
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          const current = runner;
          if (current === undefined) {
            if (!request.signal.aborted) yield { type: 'error', error: adapterError('invalid') };
            return;
          }
          const prompt =
            request.command.type === 'start' ? promptOf(request.command.input) : undefined;
          if (request.command.type !== 'start' || active !== undefined || prompt === undefined) {
            if (!request.signal.aborted)
              yield {
                type: 'error',
                error: adapterError(request.command.type === 'start' ? 'invalid' : 'unsupported'),
              };
            return;
          }
          const span = request.trace.start({ kind: 'node', name: 'adk.run' });
          const run = new RunState(
            {
              capabilities: request.capabilities,
              models: request.models,
              trace: request.trace,
              limits: request.limits,
              signal: request.signal,
            },
            span,
          );
          active = run;
          conversation = request.sessionId;
          let last: FinalResponse | undefined;
          let thrown: unknown;
          try {
            const session = await sessions.getOrCreateSession({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId: request.sessionId,
            });
            run.seedCallIds(
              session.events.reduce(
                (count, event) =>
                  count +
                  (event.content?.parts ?? []).filter((part) => part.functionCall !== undefined)
                    .length,
                0,
              ),
            );
            for await (const event of current.runAsync({
              userId: USER_ID,
              sessionId: request.sessionId,
              newMessage: { role: 'user', parts: [{ text: prompt }] },
              runConfig: {
                // A backstop only: the model call count in RunState enforces `limits.steps`.
                maxLlmCalls: request.limits.steps + 1,
                streamingMode: StreamingMode.NONE,
                pauseOnToolCalls: false,
              },
              abortSignal: run.signal,
            })) {
              if (event.errorCode !== undefined && run.failure === undefined) run.fail(undefined);
              // A tool that pauses the run needs interrupts, which this stage does not offer.
              if (
                (event.longRunningToolIds?.length ?? 0) > 0 ||
                Object.keys(event.actions?.requestedToolConfirmations ?? {}).length > 0
              ) {
                run.fail(failure('unsupported'));
                break;
              }
              if (event.partial === true || !isFinalResponse(event)) continue;
              const text = (event.content?.parts ?? [])
                .filter((part) => part.thought !== true)
                .map((part) => part.text ?? '')
                .join('');
              last = { author: event.author, text, delta: event.actions?.stateDelta };
            }
          } catch (error) {
            thrown = error;
          } finally {
            active = undefined;
          }
          const fatal =
            run.failure ??
            (thrown === undefined && last !== undefined
              ? undefined
              : toGalaxieError(thrown, 'unavailable', run.signal));
          if (fatal !== undefined) {
            span.end({ status: 'error', errorType: 'GalaxieError' });
            if (!request.signal.aborted)
              yield { type: 'error', error: adapterError(fatal.code, fatal) };
            return;
          }
          span.end({ status: 'ok' });
          if (!request.signal.aborted && last !== undefined)
            yield { type: 'output', output: outputOf(root as BaseAgent, last) };
        },
        async pending(): Promise<PendingInteraction | undefined> {
          return undefined;
        },
        async dispose(): Promise<void> {
          runner = undefined;
          sessions.clear();
        },
      };
    },
  };
}
