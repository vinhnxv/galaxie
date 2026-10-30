// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ErrorCode,
  type ExecutorAdapter,
  type ExecutorEvent,
  type ModelCall,
  type ModelPreparation,
  type ModelUsage,
  type RunRequest,
  toErrorInfo,
} from '@galaxie/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
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
  parseBridge,
  success,
  validPythonModule,
  validSourcePath,
} from './bridge.js';
import { adapterFailure, failureCode } from './errors.js';
import type { LockedWheel } from './runtime-files.js';

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
      if (message.kind === 'request') {
        this.incoming(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending || message.op !== pending.op) throw adapterFailure('invalid');
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.payload);
      else pending.reject(adapterFailure(message.error.code));
    } catch {
      this.close('invalid');
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

export function createPyodideAdapter(
  options: PyodideAdapterOptions,
): ExecutorAdapter<PyodideAgent, PyodideServices> {
  return {
    id: 'langgraph-python',
    version: '0.0.0',
    features: {
      interrupts: false,
      resume: false,
      checkpoints: false,
      streaming: false,
      subgraphs: false,
    },
    async prepare(agent, services, preparation) {
      services = services === undefined ? { chatModels: {} } : services;
      if (
        !validAgent(agent) ||
        !validServices(services, preparation.models) ||
        typeof options?.createWorker !== 'function' ||
        typeof options.runtimeUrl !== 'string' ||
        !Array.isArray(options.localWheels)
      )
        throw adapterFailure('invalid');
      const base = sourceBase(agent, options);
      let connection: Connection | undefined;
      let active: ActiveRun | undefined;
      let disposed = false;
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
              const input = message.payload as ModelPayload;
              const lease = await run.request.models.begin(input.role, {
                signal: run.request.signal,
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
              const messages = input.messages.map((item) =>
                item.role === 'system'
                  ? new SystemMessage(item.content)
                  : item.role === 'user'
                    ? new HumanMessage(item.content)
                    : new AIMessage(item.content),
              );
              const reply = await provider.invoke(messages, {
                signal: run.request.signal,
                ...(input.options.stop === undefined ? {} : { stop: [...input.options.stop] }),
                [Symbol.for('galaxie.model.destination')]: lease.destination,
              });
              if (
                typeof reply.content !== 'string' ||
                reply.tool_calls?.length ||
                reply.invalid_tool_calls?.length ||
                reply.additional_kwargs['tool_calls']
              )
                throw adapterFailure('unsupported');
              await lease.checkOutput(reply.content, { final: true });
              if (run.cancelled || run.request.signal.aborted) throw adapterFailure('cancelled');
              const reported: unknown = Reflect.get(reply, 'usage_metadata');
              if (reported !== undefined && !object(reported)) throw adapterFailure('invalid');
              const result = {
                content: reply.content,
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
              const run = active;
              if (run) for (const call of run.leases) finish(run, call);
            },
          );
          connection = client;
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          const payload: BootPayload = {
            runtimeUrl: options.runtimeUrl,
            wheelsUrl: options.wheelsUrl,
            localWheels: options.localWheels,
            sources,
            module: agent.module,
            entry: agent.entry,
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
      return {
        async *run(request): AsyncGenerator<ExecutorEvent> {
          let run: ActiveRun | undefined;
          let cancel: (() => void) | undefined;
          try {
            if (disposed || active) throw adapterFailure('invalid');
            if (request.command.type !== 'start') throw adapterFailure('unsupported');
            const client = await boot(request.signal);
            if (request.signal.aborted) throw adapterFailure('cancelled');
            const result = client.request(
              'run',
              { input: request.command.input, steps: request.limits.steps },
              'result',
              (id) => {
                run = { id, request, seen: new Set(), leases: new Set(), cancelled: false };
                active = run;
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
            const output = (await result) as { output: unknown };
            if (!request.signal.aborted) yield { type: 'output', output: output.output };
          } catch (error) {
            if (!request.signal.aborted)
              yield { type: 'error', error: toErrorInfo(failureCode(error)) };
          } finally {
            if (run?.cancellation) await run.cancellation;
            if (cancel) request.signal.removeEventListener('abort', cancel);
            if (run) for (const call of run.leases) finish(run, call);
            if (active === run) active = undefined;
          }
        },
        async pending() {
          return undefined;
        },
        async dispose() {
          disposed = true;
          connection?.close('cancelled');
          active?.finishCancellation?.();
        },
      };
    },
  };
}
