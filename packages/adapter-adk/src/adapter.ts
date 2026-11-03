// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ExecutorAdapter,
  type ExecutorEvent,
  type InteractionId,
  isGalaxieError,
  type PendingInteraction,
  parseInteractionRequest,
  type SessionId,
} from '@galaxie/core';
import {
  type BaseAgent,
  createEvent,
  isFinalResponse,
  LlmAgent,
  ParallelAgent,
  Runner,
  StreamingMode,
  setLogger,
  ToolCallIntegrityPlugin,
} from '@google/adk';
import { adapterError, failure } from './errors.js';
import { type AdkAgent, type AdkServices, createHost, validServices } from './host.js';
import {
  type AdkEntry,
  answerOf,
  defaultResume,
  isAdkEntry,
  type PausedCall,
  PauseTracker,
} from './interaction.js';
import { RunState, toGalaxieError } from './run.js';
import { ensureAdkRuntimeEnv } from './runtime-shim.js';
import { GalaxieSessionService } from './session.js';
import { StreamProjector } from './stream.js';
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

/** Branches of a ParallelAgent interleave their events, so a pause there cannot be told apart. */
function hasParallel(agent: BaseAgent): boolean {
  return agent instanceof ParallelAgent || agent.subAgents.some(hasParallel);
}

function findAgent(root: BaseAgent, name: string): BaseAgent | undefined {
  return root.name === name ? root : root.findSubAgent(name);
}

/** A pause waiting for the user: the interaction the host shows and the calls it answers. */
interface StoredPause {
  readonly interaction: PendingInteraction;
  readonly calls: readonly PausedCall[];
}

async function digestOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function createAdkAdapter(): ExecutorAdapter<AdkAgent, AdkServices> {
  return {
    id: 'adk-js',
    version: '0.0.0',
    features: {
      interrupts: true,
      resume: true,
      checkpoints: false,
      streaming: true,
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
      const built: unknown = agent(host);
      const entry: AdkEntry | undefined = isAdkEntry(built) ? built : undefined;
      const root: unknown = entry === undefined ? built : entry.agent;
      validateAgentTree(root, registry);
      const sessions = new GalaxieSessionService();
      const pauses = new Map<string, StoredPause>();
      /** Confirmations whose pause was consumed without an answer; their gated calls need a reply. */
      const abandoned = new Map<string, readonly PausedCall[]>();
      const parallel = hasParallel(root as BaseAgent);
      const ordinals = new Map<string, number>();
      let runner: Runner | undefined = new Runner({
        appName: APP_NAME,
        agent: root as BaseAgent,
        plugins: [
          new ToolCallIntegrityPlugin({ secretKey: crypto.getRandomValues(new Uint8Array(32)) }),
        ],
        sessionService: sessions,
      });
      /** Builds the interaction for a pause; the author's request must be the four-field JSON form. */
      const pauseOf = async (
        sessionId: SessionId,
        calls: readonly PausedCall[],
      ): Promise<StoredPause> => {
        let request: ReturnType<typeof parseInteractionRequest>;
        try {
          request =
            entry?.interaction === undefined
              ? undefined
              : parseInteractionRequest(
                  entry.interaction(calls.map((call) => structuredClone(call.request))),
                );
        } catch {
          request = undefined;
        }
        if (request === undefined) throw failure('unsupported');
        const ordinal = ordinals.get(sessionId) ?? 0;
        ordinals.set(sessionId, ordinal + 1);
        const interactionId = (await digestOf([sessionId, ordinal])) as InteractionId;
        return { interaction: { interactionId, ...request }, calls };
      };
      const abandon = (sessionId: SessionId, calls: readonly PausedCall[]): void => {
        abandoned.set(sessionId, [...(abandoned.get(sessionId) ?? []), ...calls]);
      };
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          const current = runner;
          if (current === undefined) {
            if (!request.signal.aborted) yield { type: 'error', error: adapterError('invalid') };
            return;
          }
          const { command, sessionId } = request;
          const refuse = (code: 'invalid' | 'stale' | 'unsupported'): ExecutorEvent[] =>
            request.signal.aborted ? [] : [{ type: 'error', error: adapterError(code) }];
          if (active !== undefined) {
            yield* refuse('invalid');
            return;
          }
          let message: { role: 'user'; parts: { text: string }[] } | ReturnType<typeof answerOf>;
          if (command.type === 'start') {
            const prompt = promptOf(command.input);
            if (prompt === undefined) {
              yield* refuse('invalid');
              return;
            }
            const dropped = pauses.get(sessionId);
            if (dropped !== undefined) abandon(sessionId, dropped.calls);
            pauses.delete(sessionId);
            message = { role: 'user', parts: [{ text: prompt }] };
          } else {
            // The pause is consumed by this resume, whether or not the answer is valid.
            const stored = pauses.get(sessionId);
            if (
              stored === undefined ||
              stored.interaction.interactionId !== command.interactionId
            ) {
              yield* refuse('stale');
              return;
            }
            pauses.delete(sessionId);
            try {
              message = answerOf(
                stored.calls,
                (entry?.resume ?? defaultResume)(
                  stored.calls.map((call) => structuredClone(call.request)),
                  command.action,
                  structuredClone(command.payload),
                ),
              );
            } catch {
              abandon(sessionId, stored.calls);
              yield* refuse('invalid');
              return;
            }
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
          conversation = sessionId;
          let last: FinalResponse | undefined;
          const projector = new StreamProjector();
          const tracker = new PauseTracker();
          let thrown: unknown;
          try {
            const session = await sessions.getOrCreateSession({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId,
            });
            const orphans = abandoned.get(sessionId);
            if (orphans !== undefined) {
              abandoned.delete(sessionId);
              // A declined confirmation leaves its gated call without a response, which the
              // model providers reject; answer it as ADK words a denial.
              const replies = orphans.flatMap((call) =>
                call.gated === undefined
                  ? []
                  : [
                      {
                        functionResponse: {
                          id: call.gated.id,
                          name: call.gated.name,
                          response: { error: 'This tool call is rejected.' },
                        },
                      },
                    ],
              );
              if (replies.length > 0)
                await sessions.appendEvent({
                  session,
                  event: createEvent({
                    author: 'user',
                    content: { role: 'user', parts: replies },
                  }),
                });
            }
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
              sessionId,
              newMessage: message,
              runConfig: {
                // A backstop only: the model call count in RunState enforces `limits.steps`.
                maxLlmCalls: request.limits.steps + 1,
                streamingMode: StreamingMode.SSE,
                pauseOnToolCalls: false,
              },
              abortSignal: run.signal,
            })) {
              if (event.errorCode !== undefined && run.failure === undefined) run.fail(undefined);
              let paused = false;
              try {
                paused = tracker.observe(event);
                if (paused && parallel) throw failure('unsupported');
              } catch (error) {
                run.fail(error);
                break;
              }
              if (run.failure === undefined && !request.signal.aborted && !paused)
                yield* projector.project(event);
              if (paused) break;
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
          const waiting = tracker.calls;
          if (tracker.unanswered && run.failure === undefined && thrown === undefined)
            run.fail(failure('unsupported'));
          const fatal =
            run.failure ??
            (thrown === undefined && (last !== undefined || waiting !== undefined)
              ? undefined
              : toGalaxieError(thrown, 'unavailable', run.signal));
          if (fatal !== undefined) {
            span.end({ status: 'error', errorType: 'GalaxieError' });
            if (!request.signal.aborted)
              yield { type: 'error', error: adapterError(fatal.code, fatal) };
            return;
          }
          if (waiting !== undefined) {
            if (request.signal.aborted || runner === undefined) {
              abandon(sessionId, waiting);
              span.end({ status: 'error', errorType: 'GalaxieError' });
              return;
            }
            let stored: StoredPause;
            try {
              stored = await pauseOf(sessionId, waiting);
            } catch (error) {
              abandon(sessionId, waiting);
              span.end({ status: 'error', errorType: 'GalaxieError' });
              const code = isGalaxieError(error) ? error.code : 'unavailable';
              if (!request.signal.aborted)
                yield { type: 'error', error: adapterError(code, error) };
              return;
            }
            if (request.signal.aborted || runner === undefined) {
              abandon(sessionId, waiting);
              span.end({ status: 'error', errorType: 'GalaxieError' });
              return;
            }
            pauses.set(sessionId, stored);
            span.end({ status: 'ok' });
            yield projector.paused();
            yield { type: 'interaction', interaction: stored.interaction };
            return;
          }
          span.end({ status: 'ok' });
          if (!request.signal.aborted && last !== undefined)
            yield { type: 'output', output: outputOf(root as BaseAgent, last) };
        },
        async pending(sessionId: SessionId): Promise<PendingInteraction | undefined> {
          return pauses.get(sessionId)?.interaction;
        },
        async dispose(): Promise<void> {
          runner = undefined;
          pauses.clear();
          abandoned.clear();
          sessions.clear();
        },
      };
    },
  };
}
