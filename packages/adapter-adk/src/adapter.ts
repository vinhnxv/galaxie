// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type ExecutorAdapter,
  type ExecutorEvent,
  type InteractionId,
  isGalaxieError,
  type PendingInteraction,
  parseInteractionRequest,
  type SessionId,
} from '@galaxie-ai/core';
import {
  type BaseAgent,
  createEvent,
  type Event,
  isFinalResponse,
  LlmAgent,
  ParallelAgent,
  Runner,
  SequentialAgent,
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
import {
  decodeRecord,
  EXECUTOR,
  encodeRecord,
  pauseAuthor,
  restoredContent,
  revisionId,
  SESSION_TYPE,
  type SessionRecord,
  STATE_TYPE,
  type StoredSession,
} from './persist.js';
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

/** Branches of a ParallelAgent interleave their events, so a pause in such a tree is refused. */
function hasParallel(agent: BaseAgent): boolean {
  return agent instanceof ParallelAgent || agent.subAgents.some(hasParallel);
}

function agentsNamed(agent: BaseAgent, name: string): BaseAgent[] {
  return [
    ...(agent.name === name ? [agent] : []),
    ...agent.subAgents.flatMap((child) => agentsNamed(child, name)),
  ];
}

/**
 * Whether resuming a pause raised by the agent called `name` would run earlier work again.
 * ADK resumes directly at the paused agent only when it and all its ancestors are LlmAgents;
 * otherwise it restarts from the root. That restart is safe only when every step down to the
 * paused agent is the first child of a SequentialAgent. An unknown or ambiguous name fails closed.
 */
export function restartsSiblings(root: BaseAgent, name: string): boolean {
  const found = agentsNamed(root, name);
  const target = found[0];
  if (found.length !== 1 || target === undefined) return true;
  const chain: BaseAgent[] = [];
  for (let up = target.parentAgent; up !== undefined; up = up.parentAgent) chain.unshift(up);
  if (chain.every((agent) => agent instanceof LlmAgent)) return false;
  const path = [...chain, target];
  return chain.some((parent, index) => {
    return !(parent instanceof SequentialAgent) || parent.subAgents[0] !== path[index + 1];
  });
}

/** The same author-position rule admits live pauses and stored pauses before restore. */
export function pauseAdmitted(
  root: BaseAgent,
  parallel: boolean,
  author: string | undefined,
): boolean {
  return !parallel && author !== undefined && !restartsSiblings(root, author);
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
      checkpoints: true,
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
      const store = services.checkpoints;
      const pauses = new Map<string, StoredPause>();
      /** Confirmations whose pause was consumed without an answer; their gated calls need a reply. */
      const abandoned = new Map<string, readonly PausedCall[]>();
      const parallel = hasParallel(root as BaseAgent);
      const ordinals = new Map<string, number>();
      /** Per conversation: the integrity key, its runner, the stored revision and the load state. */
      const keys = new Map<string, Uint8Array>();
      const runners = new Map<string, Runner>();
      const revisions = new Map<string, number>();
      const known = new Set<string>();
      const loading = new Map<string, Promise<void>>();
      let disposed = false;
      const authorOf = (
        sessionId: SessionId,
        calls: readonly PausedCall[],
        events: readonly Event[] = sessions.eventsOf(APP_NAME, USER_ID, sessionId),
      ): string | undefined => pauseAuthor(calls, events);
      const runnerFor = (sessionId: SessionId): Runner => {
        let runner = runners.get(sessionId);
        if (runner === undefined) {
          let key = keys.get(sessionId);
          if (key === undefined) {
            key = crypto.getRandomValues(new Uint8Array(32));
            keys.set(sessionId, key);
          }
          runner = new Runner({
            appName: APP_NAME,
            agent: root as BaseAgent,
            plugins: [new ToolCallIntegrityPlugin({ secretKey: key })],
            sessionService: sessions,
          });
          runners.set(sessionId, runner);
        }
        return runner;
      };
      /** Reads the stored conversation once, registering its content as private before replay. */
      const load = async (
        sessionId: SessionId,
        register: ((value: unknown) => void) | undefined,
      ): Promise<void> => {
        if (store !== undefined) {
          let reply: unknown;
          try {
            reply = await store.request({
              op: 'get',
              executor: EXECUTOR,
              sessionId,
              namespace: '',
            });
          } catch (error) {
            throw toGalaxieError(error, 'unavailable');
          }
          if (reply !== null) {
            const stored = await storedOf(sessionId, reply);
            if (
              stored.pause !== undefined &&
              !pauseAdmitted(
                root as BaseAgent,
                parallel,
                authorOf(sessionId, stored.pause.calls, stored.events),
              )
            )
              throw failure('unrecoverable');
            if (register === undefined) throw failure('unsupported');
            try {
              register(restoredContent(stored));
            } catch (error) {
              const code = toGalaxieError(error, 'unrecoverable').code;
              throw failure(code === 'stale' || code === 'cancelled' ? code : 'unrecoverable');
            }
            if (disposed) return;
            await sessions.load(APP_NAME, USER_ID, sessionId, stored.events);
            if (disposed) return;
            keys.set(sessionId, stored.key);
            ordinals.set(sessionId, stored.ordinal);
            revisions.set(sessionId, stored.revision);
            if (stored.pause !== undefined)
              pauses.set(sessionId, {
                interaction: stored.pause.interaction,
                calls: stored.pause.calls,
              });
          }
        }
        known.add(sessionId);
      };
      const storedOf = (sessionId: SessionId, reply: unknown): Promise<StoredSession> => {
        const value = reply as Record<string, unknown> | null;
        if (
          typeof value !== 'object' ||
          value === null ||
          value['sessionId'] !== sessionId ||
          value['namespace'] !== '' ||
          typeof value['checkpoint'] !== 'object' ||
          value['checkpoint'] === null ||
          typeof value['metadata'] !== 'object' ||
          value['metadata'] === null
        )
          return Promise.reject(failure('unrecoverable'));
        return decodeRecord(sessionId, digestOf, {
          id: value['id'],
          checkpoint: value['checkpoint'] as { type: unknown; bytes: unknown },
          metadata: value['metadata'] as { type: unknown; bytes: unknown },
        });
      };
      const hydrate = (
        sessionId: SessionId,
        register: ((value: unknown) => void) | undefined,
      ): Promise<void> => {
        if (disposed || known.has(sessionId)) return Promise.resolve();
        let reading = loading.get(sessionId);
        if (reading === undefined) {
          reading = load(sessionId, register).finally(() => loading.delete(sessionId));
          loading.set(sessionId, reading);
        }
        return reading;
      };
      /** Writes the conversation after a pause or completion: the marker first, then the commit. */
      const persist = async (
        sessionId: SessionId,
        pause: StoredPause | undefined,
      ): Promise<void> => {
        if (store === undefined) return;
        const key = keys.get(sessionId);
        if (key === undefined) throw failure('invalid');
        const record = {
          events: sessions.eventsOf(APP_NAME, USER_ID, sessionId),
          ordinal: ordinals.get(sessionId) ?? 0,
          ...(pause === undefined ? {} : { pause }),
        };
        const { checkpoint, metadata } = encodeRecord(sessionId, record, key);
        const previous = revisions.get(sessionId) ?? 0;
        const location = {
          executor: EXECUTOR,
          sessionId,
          namespace: '',
          id: revisionId(previous + 1),
        };
        try {
          // The checkpoint is the commit marker; an orphan marker from a failed save is replaced.
          await store.request({
            op: 'put-writes',
            ...location,
            taskId: 'conversation',
            taskPath: '',
            writes: [
              {
                channel: '__interrupt__',
                index: -3,
                interruptIds: pause === undefined ? [] : [pause.interaction.interactionId],
                value: {
                  type: 'json',
                  bytes: new TextEncoder().encode(
                    JSON.stringify(
                      pause === undefined ? null : { id: pause.interaction.interactionId },
                    ),
                  ),
                },
              },
            ],
          });
          await store.request({
            op: 'put',
            ...location,
            parentId: previous > 0 ? revisionId(previous) : null,
            checkpoint: { type: SESSION_TYPE, bytes: checkpoint },
            metadata: { type: STATE_TYPE, bytes: metadata },
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          throw toGalaxieError(error, 'unavailable');
        }
        revisions.set(sessionId, previous + 1);
      };
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
          if (disposed) {
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
          try {
            await hydrate(sessionId, request.registerRestoredData);
          } catch (error) {
            const fatal = toGalaxieError(error, 'unavailable', request.signal);
            if (!request.signal.aborted)
              yield { type: 'error', error: adapterError(fatal.code, fatal) };
            return;
          }
          if (disposed) return;
          if (store !== undefined && request.registerRestoredData !== undefined) {
            // Core clears its private values at every run end, so the stored history is
            // registered again for each run that can replay it (KTD8).
            const waiting = pauses.get(sessionId);
            const record: SessionRecord = {
              events: sessions.eventsOf(APP_NAME, USER_ID, sessionId),
              ordinal: 0,
              ...(waiting === undefined ? {} : { pause: waiting }),
            };
            try {
              request.registerRestoredData(restoredContent(record));
            } catch (error) {
              const fatal = toGalaxieError(error, 'unrecoverable', request.signal);
              if (!request.signal.aborted)
                yield { type: 'error', error: adapterError(fatal.code, fatal) };
              return;
            }
          }
          let message: { role: 'user'; parts: { text: string }[] } | ReturnType<typeof answerOf>;
          /** The pause this run resumes; its calls need a reply if the run does not complete. */
          let consumed: readonly PausedCall[] | undefined;
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
            consumed = stored.calls;
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
          /** How many events the conversation held before this run, to undo a run that fails. */
          let before = 0;
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
            before = session.events.length;
            run.seedCallIds(
              session.events.reduce(
                (count, event) =>
                  count +
                  (event.content?.parts ?? []).filter((part) => part.functionCall !== undefined)
                    .length,
                0,
              ),
            );
            for await (const event of runnerFor(sessionId).runAsync({
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
                if (
                  paused &&
                  !pauseAdmitted(
                    root as BaseAgent,
                    parallel,
                    authorOf(sessionId, tracker.calls ?? []),
                  )
                )
                  throw failure('unsupported');
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
          /** A run that does not complete writes nothing and leaves the conversation as it was. */
          const undo = async (): Promise<void> => {
            await sessions.truncate(APP_NAME, USER_ID, sessionId, before);
            if (consumed !== undefined) abandon(sessionId, consumed);
          };
          const waiting = tracker.calls;
          if (tracker.unanswered && run.failure === undefined && thrown === undefined)
            run.fail(failure('unsupported'));
          const fatal =
            run.failure ??
            (thrown === undefined && (last !== undefined || waiting !== undefined)
              ? undefined
              : toGalaxieError(thrown, 'unavailable', run.signal));
          if (fatal !== undefined) {
            await undo();
            span.end({ status: 'error', errorType: 'GalaxieError' });
            if (!request.signal.aborted)
              yield { type: 'error', error: adapterError(fatal.code, fatal) };
            return;
          }
          if (waiting !== undefined) {
            if (request.signal.aborted || disposed) {
              await undo();
              abandon(sessionId, waiting);
              span.end({ status: 'error', errorType: 'GalaxieError' });
              return;
            }
            let stored: StoredPause;
            try {
              stored = await pauseOf(sessionId, waiting);
              if (!request.signal.aborted && !disposed) await persist(sessionId, stored);
            } catch (error) {
              await undo();
              span.end({ status: 'error', errorType: 'GalaxieError' });
              const code = isGalaxieError(error) ? error.code : 'unavailable';
              if (!request.signal.aborted)
                yield { type: 'error', error: adapterError(code, error) };
              return;
            }
            if (request.signal.aborted || disposed) {
              await undo();
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
          if (!request.signal.aborted && !disposed && last !== undefined) {
            try {
              await persist(sessionId, undefined);
            } catch (error) {
              await undo();
              span.end({ status: 'error', errorType: 'GalaxieError' });
              const fatal = toGalaxieError(error, 'unavailable', request.signal);
              if (!request.signal.aborted)
                yield { type: 'error', error: adapterError(fatal.code, fatal) };
              return;
            }
          }
          if (request.signal.aborted || disposed) {
            await undo();
            span.end({ status: 'error', errorType: 'GalaxieError' });
            return;
          }
          span.end({ status: 'ok' });
          if (last !== undefined)
            yield { type: 'output', output: outputOf(root as BaseAgent, last) };
        },
        async pending(
          sessionId: SessionId,
          options?: { registerRestoredData?: (value: unknown) => void },
        ): Promise<PendingInteraction | undefined> {
          await hydrate(sessionId, options?.registerRestoredData);
          return pauses.get(sessionId)?.interaction;
        },
        async dispose(): Promise<void> {
          disposed = true;
          runners.clear();
          keys.clear();
          pauses.clear();
          abandoned.clear();
          ordinals.clear();
          revisions.clear();
          loading.clear();
          known.clear();
          sessions.clear();
        },
      };
    },
  };
}
