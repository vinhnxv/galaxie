// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorCode, toErrorInfo } from '@galaxie/core';
import type { LockedWheel } from './runtime-files.js';

export const BRIDGE_VERSION: 'galaxie.bridge/v2' = 'galaxie.bridge/v2';
export const MAX_BRIDGE_BYTES: number = 1_048_576;
export type BridgeOp =
  | 'boot'
  | 'run'
  | 'pending'
  | 'model'
  | 'capability'
  | 'abort'
  | 'result'
  | 'stream'
  | 'model-chunk';
interface Envelope {
  readonly v: typeof BRIDGE_VERSION;
  readonly id: string;
  readonly op: BridgeOp;
}
export type BridgeMessage = Envelope &
  (
    | { readonly kind: 'request'; readonly payload: unknown }
    | { readonly kind: 'notify'; readonly payload: unknown }
    | { readonly kind: 'response'; readonly ok: true; readonly payload: unknown }
    | {
        readonly kind: 'response';
        readonly ok: false;
        readonly error: { readonly code: ErrorCode };
      }
  );
export interface BootPayload {
  readonly runtimeUrl: string;
  readonly wheelsUrl: string;
  readonly localWheels: readonly LockedWheel[];
  readonly sources: readonly { readonly path: string; readonly text: string }[];
  readonly module: string;
  readonly entry: string;
}
export interface RunPayload {
  readonly threadId: string;
  readonly input?: unknown;
  readonly resume?: {
    readonly interactionId: string;
    readonly action: string;
    readonly payload: unknown;
  };
  readonly steps: number;
}
export interface PendingReply {
  readonly interrupts: readonly { readonly id?: string; readonly value: unknown }[];
}
export interface ModelPayload {
  readonly role: string;
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly options: { readonly stop?: readonly string[] };
}
export interface ModelReply {
  readonly content: string;
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}
export interface CapabilityPayload {
  readonly name: string;
  readonly input: unknown;
  readonly effectScope?: string;
}

export class BridgeValidationError extends Error {
  readonly code: 'invalid' | 'unsupported';
  constructor(code: 'invalid' | 'unsupported' = 'invalid') {
    super(toErrorInfo(code).message);
    this.code = code;
    this.name = 'BridgeValidationError';
  }
}
const codes: ReadonlySet<string> = new Set([
  'invalid',
  'denied',
  'unavailable',
  'unreachable',
  'unsupported',
  'budget_exceeded',
  'timeout',
  'stale',
  'duplicate',
  'fenced',
  'cancelled',
  'unrecoverable',
  'outcome_unknown',
  'executor_error',
]);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function validSourcePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.(?:py|json)$/.test(value)
  );
}
export function validPythonModule(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)
  );
}
function wheel(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, ['name', 'version', 'file', 'bytes', 'sha256'], ['url']) &&
    text(value['name']) &&
    text(value['version']) &&
    typeof value['file'] === 'string' &&
    /^[A-Za-z0-9_.+-]+\.whl$/.test(value['file']) &&
    count(value['bytes']) &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['sha256']) &&
    (value['url'] === undefined || text(value['url']))
  );
}
function json(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  ancestors.add(value);
  const valid = Object.values(value).every((entry) => json(entry, ancestors));
  ancestors.delete(value);
  return valid;
}
function requestPayload(op: BridgeOp, value: unknown): boolean {
  if (!object(value)) return false;
  switch (op) {
    case 'boot':
      return (
        keys(value, ['runtimeUrl', 'wheelsUrl', 'localWheels', 'sources', 'module', 'entry']) &&
        text(value['runtimeUrl']) &&
        text(value['wheelsUrl']) &&
        Array.isArray(value['localWheels']) &&
        value['localWheels'].every(wheel) &&
        Array.isArray(value['sources']) &&
        value['sources'].length > 0 &&
        value['sources'].every(
          (source: unknown) =>
            object(source) &&
            keys(source, ['path', 'text']) &&
            validSourcePath(source['path']) &&
            typeof source['text'] === 'string',
        ) &&
        validPythonModule(value['module']) &&
        typeof value['entry'] === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(value['entry'])
      );
    case 'run':
      return (
        keys(value, ['threadId', 'steps'], ['input', 'resume']) &&
        text(value['threadId']) &&
        Object.hasOwn(value, 'input') !== Object.hasOwn(value, 'resume') &&
        (Object.hasOwn(value, 'input')
          ? json(value['input'])
          : object(value['resume']) &&
            keys(value['resume'], ['interactionId', 'action', 'payload']) &&
            text(value['resume']['interactionId']) &&
            text(value['resume']['action']) &&
            json(value['resume']['payload'])) &&
        count(value['steps']) &&
        value['steps'] > 0
      );
    case 'pending':
      return keys(value, ['threadId']) && text(value['threadId']);
    case 'model':
      return (
        keys(value, ['role', 'messages', 'options']) &&
        text(value['role']) &&
        Array.isArray(value['messages']) &&
        value['messages'].every(
          (message: unknown) =>
            object(message) &&
            keys(message, ['role', 'content']) &&
            ['system', 'user', 'assistant'].includes(message['role'] as string) &&
            typeof message['content'] === 'string',
        ) &&
        object(value['options']) &&
        keys(value['options'], [], ['stop']) &&
        (value['options']['stop'] === undefined ||
          (Array.isArray(value['options']['stop']) &&
            value['options']['stop'].every((item: unknown) => typeof item === 'string')))
      );
    case 'capability':
      return (
        keys(value, ['name', 'input'], ['effectScope']) &&
        text(value['name']) &&
        json(value['input']) &&
        (value['effectScope'] === undefined || text(value['effectScope']))
      );
    case 'abort':
      return keys(value, ['runId']) && text(value['runId']);
    case 'result':
    case 'stream':
    case 'model-chunk':
      return false;
  }
}
function responsePayload(op: BridgeOp, value: unknown): boolean {
  switch (op) {
    case 'boot':
      return (
        object(value) &&
        keys(value, ['coldStartMs']) &&
        typeof value['coldStartMs'] === 'number' &&
        Number.isFinite(value['coldStartMs']) &&
        value['coldStartMs'] >= 0
      );
    case 'model': {
      if (
        !object(value) ||
        !keys(value, ['content'], ['usage']) ||
        typeof value['content'] !== 'string'
      )
        return false;
      const usage = value['usage'];
      return (
        usage === undefined ||
        (object(usage) &&
          keys(usage, ['input_tokens', 'output_tokens', 'total_tokens']) &&
          count(usage['input_tokens']) &&
          count(usage['output_tokens']) &&
          count(usage['total_tokens']) &&
          usage['input_tokens'] + usage['output_tokens'] === usage['total_tokens'])
      );
    }
    case 'capability':
      return json(value);
    case 'abort':
      return value === null;
    case 'result':
      return (
        object(value) &&
        ((keys(value, ['output']) && json(value['output'])) ||
          (keys(value, ['interrupted']) && value['interrupted'] === true))
      );
    case 'pending':
      return (
        object(value) &&
        keys(value, ['interrupts']) &&
        Array.isArray(value['interrupts']) &&
        value['interrupts'].every(
          (item: unknown) =>
            object(item) &&
            keys(item, ['value'], ['id']) &&
            (item['id'] === undefined || typeof item['id'] === 'string') &&
            json(item['value']),
        )
      );
    case 'run':
    case 'stream':
    case 'model-chunk':
      return false;
  }
}
function valid(value: unknown): value is BridgeMessage {
  if (
    !object(value) ||
    value['v'] !== BRIDGE_VERSION ||
    !text(value['id']) ||
    ![
      'boot',
      'run',
      'pending',
      'model',
      'capability',
      'abort',
      'result',
      'stream',
      'model-chunk',
    ].includes(value['op'] as string)
  )
    return false;
  const op = value['op'] as BridgeOp;
  if (value['kind'] === 'notify') {
    if (!keys(value, ['v', 'kind', 'id', 'op', 'payload'])) return false;
    const payload = value['payload'];
    if (op === 'model-chunk')
      return (
        object(payload) && keys(payload, ['content']) && typeof payload['content'] === 'string'
      );
    return (
      op === 'stream' &&
      Array.isArray(payload) &&
      payload.length === 3 &&
      Array.isArray(payload[0]) &&
      payload[0].every((item: unknown) => typeof item === 'string') &&
      ['values', 'updates', 'messages', 'custom'].includes(payload[1] as string) &&
      json(payload[2])
    );
  }
  if (value['kind'] === 'request')
    return (
      keys(value, ['v', 'kind', 'id', 'op', 'payload']) && requestPayload(op, value['payload'])
    );
  if (value['kind'] !== 'response') return false;
  if (value['ok'] === true)
    return (
      keys(value, ['v', 'kind', 'id', 'op', 'ok', 'payload']) &&
      responsePayload(op, value['payload'])
    );
  return (
    value['ok'] === false &&
    keys(value, ['v', 'kind', 'id', 'op', 'ok', 'error']) &&
    object(value['error']) &&
    keys(value['error'], ['code']) &&
    codes.has(value['error']['code'] as string)
  );
}
export function parseBridge(value: unknown): BridgeMessage {
  if (typeof value === 'string' && new TextEncoder().encode(value).length > MAX_BRIDGE_BYTES)
    throw new BridgeValidationError('unsupported');
  try {
    if (typeof value !== 'string') throw new BridgeValidationError();
    const parsed: unknown = JSON.parse(value);
    if (!valid(parsed)) throw new BridgeValidationError();
    return parsed;
  } catch {
    throw new BridgeValidationError();
  }
}
export function encodeBridge(message: BridgeMessage): string {
  let encoded: string;
  try {
    if (!json(message) || !valid(message)) throw new BridgeValidationError();
    encoded = JSON.stringify(message);
  } catch {
    throw new BridgeValidationError();
  }
  if (new TextEncoder().encode(encoded).length > MAX_BRIDGE_BYTES)
    throw new BridgeValidationError('unsupported');
  return encoded;
}
export function success(
  request: BridgeMessage,
  payload: unknown,
  op: BridgeOp = request.op,
): BridgeMessage {
  return { v: BRIDGE_VERSION, kind: 'response', id: request.id, op, ok: true, payload };
}
export function failure(
  request: BridgeMessage,
  code: ErrorCode,
  op: BridgeOp = request.op,
): BridgeMessage {
  return { v: BRIDGE_VERSION, kind: 'response', id: request.id, op, ok: false, error: { code } };
}
