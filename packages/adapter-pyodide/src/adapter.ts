// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ErrorCode,
  type ExecutorAdapter,
  type ExecutorEvent,
  type InteractionId,
  type ModelCall,
  type ModelPreparation,
  type ModelUsage,
  type PendingInteraction,
  parseInteractionRequest,
  type RunRequest,
  toErrorInfo,
} from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import {
  type BootPayload,
  BRIDGE_VERSION,
  type BridgeMessage,
  type BridgeOp,
  type CapabilityPayload,
  encodeBridge,
  failure,
  MAX_BRIDGE_BYTES,
  type ModelPayload,
  type ModelReply,
  type PendingReply,
  parseBridge,
  type StreamPayload,
  success,
  validPythonModule,
  validSourcePath,
} from './bridge.js';
import { checkpointBytes, dspyCheckpointValues } from './checkpoints.js';
import { adapterFailure, failureCode } from './errors.js';
import type { LockedWheel, PythonFramework } from './runtime-files.js';
import { GrowingOutput, outputText, toolCalls } from './tool-calls.js';

export interface PyodideAgent {
  readonly baseUrl: string;
  readonly files: readonly string[];
  readonly module: string;
  readonly entry: string;
}
export type PyodideChatModel =
  | BaseChatModel
  | ((options: { readonly credential: string }) => BaseChatModel);
export interface PyodideServices {
  readonly chatModels: Readonly<Record<string, PyodideChatModel>>;
  readonly checkpoints?: { request(value: unknown): Promise<unknown> };
}
export interface PyodideWorkerPort {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  terminate(): void;
}
export interface PyodideBootEvent {
  readonly phase: 'booting' | 'ready' | 'failed';
  readonly coldStartMs?: number;
}
export interface PyodideAdapterOptions {
  readonly framework?: PythonFramework;
  readonly createWorker: () => PyodideWorkerPort;
  readonly runtimeUrl: string;
  readonly wheelsUrl: string;
  readonly localWheels: readonly LockedWheel[];
  readonly onBoot?: (event: PyodideBootEvent) => void;
}

interface Pending {
  readonly op: BridgeOp;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
class Connection {
  private readonly pending: Map<string, Pending> = new Map();
  private sequence: number = 0;
  private closed: boolean = false;
  private readonly port: PyodideWorkerPort;
  private readonly incoming: (message: BridgeMessage) => void;
  private readonly onClose: () => void;
  constructor(
    port: PyodideWorkerPort,
    incoming: (message: BridgeMessage) => void,
    onClose: () => void,
  ) {
    this.port = port;
    this.incoming = incoming;
    this.onClose = onClose;
    port.addEventListener('message', this.receive);
    port.addEventListener('error', this.error);
  }
  private readonly receive = (event: { readonly data: unknown }): void => {
    if (this.closed) return;
    try {
      const message = parseBridge(event.data);
      if (message.kind !== 'response') {
        this.incoming(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || message.op !== pending.op) throw adapterFailure('invalid');
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.payload);
      else pending.reject(adapterFailure(message.error.code));
    } catch (error) {
      this.close(failureCode(error, 'invalid'));
    }
  };
  private readonly error = (): void => {
    this.close('unavailable');
  };
  send(message: BridgeMessage): void {
    if (this.closed) throw adapterFailure('unavailable');
    this.port.postMessage(encodeBridge(message));
  }
  request(
    op: BridgeOp,
    payload: unknown,
    responseOp: BridgeOp = op,
    beforeSend?: (id: string) => void,
  ): Promise<unknown> {
    const id = `${op}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { op: responseOp, resolve, reject });
      try {
        beforeSend?.(id);
        this.send({ v: BRIDGE_VERSION, kind: 'request', id, op, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(adapterFailure(failureCode(error, 'unavailable')));
      }
    });
  }
  close(code: ErrorCode): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener('message', this.receive);
    this.port.removeEventListener('error', this.error);
    try {
      this.port.terminate();
    } finally {
      for (const pending of this.pending.values()) pending.reject(adapterFailure(code));
      this.pending.clear();
      this.onClose();
    }
  }
}
interface LeasedCall {
  readonly lease: ModelCall;
  settled: boolean;
}
interface ActiveRun {
  readonly id: string;
  readonly request: RunRequest;
  readonly seen: Set<string>;
  readonly leases: Set<LeasedCall>;
  readonly checkpoints: Set<Promise<void>>;
  readonly streams: ExecutorEvent[];
  modelCalls: number;
  wake(): void;
  cancelled: boolean;
  cancellation?: Promise<void>;
  finishCancellation?: () => void;
}
function finish(active: ActiveRun, call: LeasedCall, usage?: ModelUsage, succeeded = false): void {
  if (call.settled) return;
  call.settled = true;
  active.leases.delete(call);
  if (succeeded) call.lease.end(usage);
  else call.lease.fail();
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validAgent(agent: unknown): agent is PyodideAgent {
  return (
    object(agent) &&
    Object.keys(agent).length === 4 &&
    typeof agent['baseUrl'] === 'string' &&
    Array.isArray(agent['files']) &&
    agent['files'].length > 0 &&
    agent['files'].every(validSourcePath) &&
    new Set(agent['files']).size === agent['files'].length &&
    validPythonModule(agent['module']) &&
    typeof agent['entry'] === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(agent['entry'])
  );
}
function validServices(services: unknown, models?: ModelPreparation): services is PyodideServices {
  if (
    !object(services) ||
    (services['checkpoints'] !== undefined &&
      (!object(services['checkpoints']) ||
        typeof services['checkpoints']['request'] !== 'function')) ||
    !object(services['chatModels']) ||
    !Object.values(services['chatModels']).every(
      (model) =>
        typeof model === 'function' || (object(model) && typeof model['invoke'] === 'function'),
    )
  )
    return false;
  const implementations = services['chatModels'];
  return Object.entries(models?.providers ?? {}).every(([id, descriptor]) => {
    const provider = Object.hasOwn(implementations, id) ? implementations[id] : undefined;
    return provider !== undefined && (typeof provider === 'function') === descriptor.credential;
  });
}
function sourceBase(agent: PyodideAgent, options: PyodideAdapterOptions): URL {
  try {
    const base = new URL(agent.baseUrl);
    const wheels = new URL(options.wheelsUrl);
    if (
      !['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !base.pathname.endsWith('/') ||
      wheels.origin !== base.origin ||
      wheels.username ||
      wheels.password ||
      !wheels.pathname.endsWith('/')
    )
      throw adapterFailure('invalid');
    if (typeof location !== 'undefined') {
      const runtime = new URL(options.runtimeUrl, location.href);
      if (
        base.origin !== location.origin ||
        runtime.origin !== location.origin ||
        runtime.username ||
        runtime.password ||
        runtime.search ||
        runtime.hash ||
        !runtime.pathname.endsWith('/')
      )
        throw adapterFailure('invalid');
    }
    return base;
  } catch {
    throw adapterFailure('invalid');
  }
}
async function source(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw adapterFailure('unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BRIDGE_BYTES) throw adapterFailure('invalid');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Passes only the restore hook into a checkpoint read context. */
function restoredDataOptions(request: RunRequest): Pick<RunRequest, 'registerRestoredData'> {
  return request.registerRestoredData === undefined
    ? {}
    : { registerRestoredData: request.registerRestoredData };
}

export function createPyodideAdapter(
  options: PyodideAdapterOptions,
): ExecutorAdapter<PyodideAgent, PyodideServices> {
  const framework = options?.framework ?? 'langgraph';
  const executorId =
    framework === 'adk'
      ? 'adk-python'
      : framework === 'dspy'
        ? 'dspy-python'
        : framework === 'pydantic-ai'
          ? 'pydantic-ai-python'
          : 'langgraph-python';
  const langgraph = framework === 'langgraph';
  // The ADK executor turns each feature on only with its own stage's evidence (ADR-0022): it
  // streams, and its interactions, resume and checkpoints stay off until their stages ship.
  const supported = framework !== 'adk';
  return {
    id: executorId,
    version: '0.0.0',
    features: {
      interrupts: supported,
      resume: supported,
      checkpoints: supported,
      streaming: true,
      subgraphs: langgraph,
    },
    async prepare(agent, services, preparation) {
      services = services === undefined ? { chatModels: {} } : services;
      if (
        !validAgent(agent) ||
        !validServices(services, preparation.models) ||
        typeof options?.createWorker !== 'function' ||
        typeof options.runtimeUrl !== 'string' ||
        !Array.isArray(options.localWheels) ||
        !['langgraph', 'pydantic-ai', 'dspy', 'adk'].includes(framework)
      )
        throw adapterFailure('invalid');
      const base = sourceBase(agent, options);
      let connection: Connection | undefined;
      let active: ActiveRun | undefined;
      let disposed = false;
      const sessions = new Set<string>();
      const lostSessions = new Set<string>();
      const paused = new Map<string, () => void>();
      const reads = new Map<
        string,
        {
          sessionId: string;
          seen: Set<string>;
          registerRestoredData?: (value: unknown) => void;
        }
      >();
      let sources: BootPayload['sources'];
      try {
        sources = await Promise.all(
          agent.files.map(async (path) => {
            const response = await fetch(new URL(path, base), {
              credentials: 'omit',
              redirect: 'error',
              signal: preparation.signal,
            });
            return { path, text: await source(response) };
          }),
        );
      } catch (error) {
        throw adapterFailure(
          preparation.signal.aborted ? 'cancelled' : failureCode(error, 'unavailable'),
        );
      }

      const dispatch = (client: Connection, message: BridgeMessage): void => {
        if (message.kind === 'notify' && message.op === 'stream') {
          const run = active;
          if (!run || !message.id.startsWith(`${run.id}/`) || run.seen.has(message.id)) {
            client.close('invalid');
            return;
          }
          run.seen.add(message.id);
          if (!run.cancelled) {
            const [path, mode, data] = message.payload as StreamPayload;
            run.streams.push({ type: 'stream', executor: executorId, path, mode, data });
            run.wake();
          }
          return;
        }
        if (message.kind === 'request' && message.op === 'checkpoint') {
          const input = message.payload as { op: string; sessionId: string };
          const run = active;
          const runContext = run !== undefined && message.id.startsWith(`${run.id}/`);
          const read = reads.get(message.id.slice(0, message.id.indexOf('/')));
          const context = runContext
            ? {
                sessionId: run.request.sessionId,
                seen: run.seen,
                registerRestoredData: run.request.registerRestoredData,
              }
            : read;
          if (
            !services.checkpoints ||
            !context ||
            input.sessionId !== context.sessionId ||
            (!runContext && !['get', 'list'].includes(input.op))
          ) {
            client.send(failure(message, 'stale'));
            return;
          }
          if (context.seen.has(message.id)) {
            client.close('invalid');
            return;
          }
          context.seen.add(message.id);
          const operation = (async () => {
            try {
              const value = await services.checkpoints?.request(
                checkpointBytes({ ...(message.payload as object), executor: executorId }, 'decode'),
              );
              if (framework === 'dspy' && input.op === 'get' && value !== null) {
                let restored: unknown;
                try {
                  restored = dspyCheckpointValues(value);
                } catch {
                  throw adapterFailure('unrecoverable');
                }
                if (restored !== undefined) {
                  if (!context.registerRestoredData) throw adapterFailure('unsupported');
                  try {
                    context.registerRestoredData(restored);
                  } catch (error) {
                    const code = failureCode(error, 'unrecoverable');
                    throw adapterFailure(
                      code === 'stale' || code === 'cancelled' ? code : 'unrecoverable',
                    );
                  }
                }
              }
              if (connection === client)
                client.send(success(message, checkpointBytes(value, 'encode')));
            } catch (error) {
              if (connection === client) {
                try {
                  client.send(failure(message, failureCode(error, 'unavailable')));
                } catch {
                  client.close('invalid');
                }
              }
            }
          })();
          if (runContext) {
            run.checkpoints.add(operation);
            void operation.finally(() => run.checkpoints.delete(operation));
          }
          return;
        }
        if (message.kind !== 'request' || (message.op !== 'model' && message.op !== 'capability')) {
          client.close('invalid');
          return;
        }
        const run = active;
        if (!run || run.cancelled || !message.id.startsWith(`${run.id}/`)) {
          client.send(failure(message, 'stale'));
          return;
        }
        if (run.seen.has(message.id)) {
          client.close('invalid');
          return;
        }
        run.seen.add(message.id);
        void (async () => {
          let call: LeasedCall | undefined;
          try {
            let payload: unknown;
            if (message.op === 'capability') {
              const input = message.payload as CapabilityPayload;
              payload = await run.request.capabilities.call(input.name, input.input, {
                signal: run.request.signal,
                ...(input.effectScope === undefined ? {} : { effectScope: input.effectScope }),
              });
            } else {
              if (framework === 'dspy' && run.modelCalls++ >= run.request.limits.steps)
                throw adapterFailure('budget_exceeded');
              const input = message.payload as ModelPayload;
              const offered = (input.options.tools?.length ?? 0) > 0;
              const requires = [
                ...(input.options.stream ? ['streaming' as const] : []),
                ...(offered ? ['tool-calling' as const] : []),
                ...(input.options.jsonSchema === undefined ? [] : ['structured-output' as const]),
              ];
              const lease = await run.request.models.begin(input.role, {
                signal: run.request.signal,
                ...(requires.length ? { requires } : {}),
              });
              call = { lease, settled: false };
              run.leases.add(call);
              if (run.cancelled || run.request.signal.aborted) throw adapterFailure('cancelled');
              const implementation = Object.hasOwn(services.chatModels, lease.providerId)
                ? services.chatModels[lease.providerId]
                : undefined;
              if (implementation === undefined) throw adapterFailure('unavailable');
              if (typeof implementation === 'function' && lease.credential === undefined)
                throw adapterFailure('invalid');
              const provider =
                typeof implementation === 'function'
                  ? implementation({ credential: lease.credential as string })
                  : implementation;
              if (offered && typeof provider.bindTools !== 'function')
                throw adapterFailure('unsupported');
              const bound = offered
                ? provider.bindTools?.(
                    [...(input.options.tools ?? [])],
                    input.options.toolChoice === undefined
                      ? {}
                      : { tool_choice: input.options.toolChoice },
                  )
                : provider;
              if (!bound) throw adapterFailure('unsupported');
              const messages = input.messages.map((item) => {
                switch (item.role) {
                  case 'system':
                    return new SystemMessage(item.content);
                  case 'user':
                    return new HumanMessage(item.content);
                  case 'tool':
                    return new ToolMessage({
                      content: item.content,
                      tool_call_id: item.tool_call_id as string,
                    });
                  case 'assistant':
                    return new AIMessage({
                      content: item.content,
                      additional_kwargs:
                        item.toolCalls === undefined ? {} : { tool_calls: [...item.toolCalls] },
                    });
                  default:
                    throw adapterFailure('invalid');
                }
              });
              const modelOptions = {
                signal: run.request.signal,
                ...(input.options.stop === undefined ? {} : { stop: [...input.options.stop] }),
                ...(input.options.jsonSchema === undefined
                  ? {}
                  : { jsonSchema: input.options.jsonSchema }),
                [Symbol.for('galaxie.model.destination')]: lease.destination,
              };
              const validateReply = (reply: AIMessage | AIMessageChunk): void => {
                if (
                  typeof reply.content !== 'string' ||
                  (!offered &&
                    (reply.tool_calls?.length ||
                      reply.invalid_tool_calls?.length ||
                      ('tool_call_chunks' in reply && reply.tool_call_chunks?.length) ||
                      reply.additional_kwargs['tool_calls']))
                )
                  throw adapterFailure('unsupported');
              };
              let reply: AIMessage | AIMessageChunk;
              let checked = '';
              if (input.options.stream) {
                let combined: AIMessageChunk | undefined;
                const growing = new GrowingOutput();
                const stream = await bound.stream(messages, modelOptions);
                for await (const chunk of stream) {
                  if (run.cancelled || run.request.signal.aborted || connection !== client)
                    throw adapterFailure('cancelled');
                  validateReply(chunk);
                  combined = combined === undefined ? chunk : combined.concat(chunk);
                  checked = offered ? growing.append(chunk) : (combined.content as string);
                  const fragments = offered
                    ? [...growing.toolCallIds(), ...growing.toolCallNames()]
                    : [];
                  await lease.checkOutput([checked, ...fragments].join('\n'), { final: false });
                  if (run.cancelled || run.request.signal.aborted || connection !== client)
                    throw adapterFailure('cancelled');
                  client.send({
                    v: BRIDGE_VERSION,
                    kind: 'notify',
                    id: message.id,
                    op: 'model-chunk',
                    payload: {
                      content: chunk.content,
                      ...(offered ? { toolCalls: growing.deltas() } : {}),
                    },
                  });
                }
                if (!combined) throw adapterFailure('unavailable');
                reply = combined;
              } else reply = await bound.invoke(messages, modelOptions);
              validateReply(reply);
              const calls = offered ? toolCalls(reply) : undefined;
              const returnedText = offered ? outputText(reply) : (reply.content as string);
              let finalText = returnedText;
              if (input.options.stream && offered) {
                finalText = checked;
                if (!checked.includes(returnedText)) finalText += `\n${returnedText}`;
              }
              // Tool-call IDs are model text that Python receives, so they are checked too.
              if (calls?.length)
                finalText = [finalText, ...calls.map((call) => call.id)].join('\n');
              await lease.checkOutput(finalText, { final: true });
              if (run.cancelled || run.request.signal.aborted) throw adapterFailure('cancelled');
              const reported: unknown = Reflect.get(reply, 'usage_metadata');
              if (reported !== undefined && !object(reported)) throw adapterFailure('invalid');
              const result = {
                content: reply.content,
                ...(calls ? { toolCalls: calls } : {}),
                ...(reported === undefined
                  ? {}
                  : {
                      usage: {
                        input_tokens: reported['input_tokens'],
                        output_tokens: reported['output_tokens'],
                        total_tokens: reported['total_tokens'],
                      },
                    }),
              };
              // Validate the reply before settling usage or exposing it to Python.
              encodeBridge(success(message, result));
              const usage = (result as ModelReply).usage;
              finish(
                run,
                call,
                usage === undefined
                  ? undefined
                  : { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
                true,
              );
              payload = result;
            }
            if (!run.cancelled && active === run && connection === client)
              client.send(success(message, payload));
          } catch (error) {
            if (!run.cancelled && active === run && connection === client) {
              try {
                client.send(failure(message, failureCode(error, 'unavailable')));
              } catch {
                client.close('invalid');
              }
            }
          } finally {
            if (call) finish(run, call);
          }
        })();
      };

      const boot = async (signal: AbortSignal): Promise<Connection> => {
        if (disposed) throw adapterFailure('invalid');
        if (signal.aborted) throw adapterFailure('cancelled');
        if (connection) return connection;
        options.onBoot?.({ phase: 'booting' });
        let client: Connection | undefined;
        const abort = (): void => {
          client?.close('cancelled');
        };
        try {
          client = new Connection(
            options.createWorker(),
            (message) => {
              if (client) dispatch(client, message);
            },
            () => {
              if (connection === client) connection = undefined;
              for (const session of sessions) lostSessions.add(session);
              sessions.clear();
              for (const release of paused.values()) release();
              paused.clear();
              const run = active;
              if (run) for (const call of run.leases) finish(run, call);
            },
          );
          connection = client;
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          const payload: BootPayload = {
            ...(framework === 'langgraph' ? {} : { framework }),
            runtimeUrl: options.runtimeUrl,
            wheelsUrl: options.wheelsUrl,
            localWheels: options.localWheels,
            sources,
            module: agent.module,
            entry: agent.entry,
            ...(services.checkpoints === undefined ? {} : { checkpoints: true }),
          };
          const ready = (await client.request('boot', payload)) as { coldStartMs: number };
          options.onBoot?.({ phase: 'ready', coldStartMs: ready.coldStartMs });
          return client;
        } catch (error) {
          client?.close('unavailable');
          options.onBoot?.({ phase: 'failed' });
          throw adapterFailure(signal.aborted ? 'cancelled' : failureCode(error, 'unavailable'));
        } finally {
          signal.removeEventListener('abort', abort);
        }
      };
      await boot(preparation.signal);
      const pending = async (
        sessionId: string,
        readOptions?: Pick<RunRequest, 'registerRestoredData'>,
      ): Promise<PendingInteraction | undefined> => {
        if (disposed) throw adapterFailure('invalid');
        if (services.checkpoints === undefined && (lostSessions.has(sessionId) || !connection))
          throw adapterFailure('unavailable');
        const client = await boot(new AbortController().signal);
        let contextId: string | undefined;
        let state: PendingReply;
        try {
          state = (await client.request('pending', { threadId: sessionId }, 'pending', (id) => {
            contextId = id;
            reads.set(id, { sessionId, seen: new Set(), ...readOptions });
          })) as PendingReply;
        } finally {
          if (contextId !== undefined) reads.delete(contextId);
        }
        if (state.interrupts.length === 0) return undefined;
        const first = state.interrupts[0];
        if (!first?.id || new Set(state.interrupts.map((item) => item.id)).size !== 1)
          throw adapterFailure('unsupported');
        const request = parseInteractionRequest(first.value);
        if (!request) throw adapterFailure('invalid');
        return { interactionId: first.id as InteractionId, ...request };
      };
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          let run: ActiveRun | undefined;
          let cancel: (() => void) | undefined;
          let outcome: { output?: unknown; interrupted?: true } | undefined;
          let failed: { error: unknown } | undefined;
          let wake = (): void => {};
          try {
            if (disposed || active) throw adapterFailure('invalid');
            const command = request.command;
            if (command.type === 'resume') {
              const interaction = await pending(request.sessionId, restoredDataOptions(request));
              if (interaction?.interactionId !== command.interactionId)
                throw adapterFailure(langgraph ? 'unsupported' : 'stale');
            } else lostSessions.delete(request.sessionId);
            paused.get(request.sessionId)?.();
            paused.delete(request.sessionId);
            const client = await boot(request.signal);
            if (request.signal.aborted) throw adapterFailure('cancelled');
            const result = client.request(
              'run',
              {
                threadId: request.sessionId,
                steps: request.limits.steps,
                ...(command.type === 'start'
                  ? { input: command.input }
                  : {
                      resume: {
                        interactionId: command.interactionId,
                        action: command.action,
                        payload: command.payload,
                      },
                    }),
              },
              'result',
              (id) => {
                run = {
                  id,
                  request,
                  seen: new Set(),
                  leases: new Set(),
                  checkpoints: new Set(),
                  streams: [],
                  modelCalls: 0,
                  wake: () => wake(),
                  cancelled: false,
                };
                active = run;
                sessions.add(request.sessionId);
                const current = run;
                cancel = (): void => {
                  if (current.cancelled) return;
                  current.cancelled = true;
                  for (const call of current.leases) finish(current, call);
                  current.cancellation = new Promise<void>((resolve) => {
                    let finished = false;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const end = (): void => {
                      if (finished) return;
                      finished = true;
                      if (timer !== undefined) clearTimeout(timer);
                      client.close('cancelled');
                      resolve();
                    };
                    current.finishCancellation = end;
                    timer = setTimeout(end, 500);
                    void client.request('abort', { runId: id }).then(end, end);
                  });
                };
                request.signal.addEventListener('abort', cancel, { once: true });
                if (request.signal.aborted) cancel();
              },
            );
            void result.then(
              (value) => {
                outcome = value as typeof outcome;
                wake();
              },
              (error: unknown) => {
                failed = { error };
                wake();
              },
            );
            for (;;) {
              const events = run?.streams.splice(0) ?? [];
              for (const event of events) if (!request.signal.aborted) yield event;
              if (run?.streams.length) continue;
              if (outcome || failed) break;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            if (failed) throw failed.error;
            const output = outcome as { output?: unknown; interrupted?: true };
            if (!request.signal.aborted) {
              if (output.interrupted) {
                const interaction = await pending(request.sessionId, restoredDataOptions(request));
                if (
                  !interaction ||
                  (command.type === 'resume' && interaction.interactionId === command.interactionId)
                )
                  throw adapterFailure('unsupported');
                const abortPaused = (): void => client.close('cancelled');
                paused.set(request.sessionId, () =>
                  request.signal.removeEventListener('abort', abortPaused),
                );
                request.signal.addEventListener('abort', abortPaused, { once: true });
                if (request.signal.aborted) abortPaused();
                else yield { type: 'interaction', interaction };
              } else yield { type: 'output', output: output.output };
            }
          } catch (error) {
            if (!request.signal.aborted)
              yield { type: 'error', error: toErrorInfo(failureCode(error)) };
          } finally {
            if (run && !outcome && !failed) cancel?.();
            if (run?.cancellation) await run.cancellation;
            if (run) await Promise.allSettled(run.checkpoints);
            if (cancel) request.signal.removeEventListener('abort', cancel);
            if (run) for (const call of run.leases) finish(run, call);
            if (active === run) active = undefined;
          }
        },
        pending,
        async dispose() {
          disposed = true;
          connection?.close('cancelled');
          active?.finishCancellation?.();
        },
      };
    },
  };
}
