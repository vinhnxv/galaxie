// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  encodeValidatedJson,
  isJsonValue as json,
  hasOnlyKeys as keys,
  MAX_BRIDGE_BYTES,
  isRecord as object,
  parseJsonText,
  validBridgeTool as toolDefinition,
  validBridgeToolCall,
  validCapabilityRequest,
  validChatMessage,
  validModelOption,
  withinBridgeLimit,
} from '@galaxie-ai/adapter-kit';
import { type ErrorCode, toErrorInfo } from '@galaxie-ai/core';
import { validCheckpointReply, validCheckpointRequest } from './checkpoints.js';
import type { LockedWheel, PythonFramework } from './runtime-files.js';

export const BRIDGE_VERSION: 'galaxie.bridge/v2' = 'galaxie.bridge/v2';
export { MAX_BRIDGE_BYTES };
export type BridgeOp =
  | 'boot'
  | 'run'
  | 'pending'
  | 'model'
  | 'capability'
  | 'abort'
  | 'result'
  | 'stream'
  | 'model-chunk'
  | 'checkpoint';
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
  readonly framework?: PythonFramework;
  readonly checkpoints?: boolean;
  readonly roles?: readonly string[];
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
    readonly role: 'system' | 'user' | 'assistant' | 'tool';
    readonly content: string;
    readonly toolCalls?: readonly ToolCall[];
    readonly tool_call_id?: string;
  }[];
  readonly options: {
    readonly stop?: readonly string[];
    readonly stream?: boolean;
    /** A JSON Schema object the reply must follow; routing requires `structured-output`. */
    readonly jsonSchema?: Readonly<Record<string, unknown>>;
    /** One-based structured-output repair index, charged through the router; requires jsonSchema. */
    readonly repairAttempt?: number;
    readonly tools?: readonly ToolDefinition[];
    readonly toolChoice?:
      | 'auto'
      | 'none'
      | 'required'
      | { readonly type: 'function'; readonly function: { readonly name: string } };
  };
}
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly strict?: boolean;
  };
}
export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}
export interface ToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: 'function';
  readonly function: { readonly name?: string; readonly arguments?: string };
}
export type StreamPayload = readonly [
  readonly string[],
  'values' | 'updates' | 'messages' | 'custom',
  unknown,
];
export interface ModelReply {
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
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
  readonly tool?: boolean;
  readonly inner?: boolean;
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
    keys(value, ['name', 'version', 'file', 'bytes', 'sha256'], ['url', 'frameworks']) &&
    (value['frameworks'] === undefined ||
      (Array.isArray(value['frameworks']) &&
        value['frameworks'].length > 0 &&
        new Set(value['frameworks']).size === value['frameworks'].length &&
        value['frameworks'].every(
          (framework: unknown) =>
            framework === 'langgraph' ||
            framework === 'pydantic-ai' ||
            framework === 'dspy' ||
            framework === 'adk',
        ))) &&
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
export function validToolCall(value: unknown): value is ToolCall {
  return validBridgeToolCall(value);
}
function toolChoice(value: unknown): boolean {
  return (
    ['auto', 'none', 'required'].includes(value as string) ||
    (object(value) &&
      keys(value, ['type', 'function']) &&
      value['type'] === 'function' &&
      object(value['function']) &&
      keys(value['function'], ['name']) &&
      text(value['function']['name']))
  );
}
function modelMessage(value: unknown): boolean {
  return validChatMessage(value, validToolCall);
}
function toolDelta(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, ['index', 'function'], ['id', 'type']) &&
    count(value['index']) &&
    (value['id'] === undefined || text(value['id'])) &&
    (value['type'] === undefined || value['type'] === 'function') &&
    object(value['function']) &&
    keys(value['function'], [], ['name', 'arguments']) &&
    (value['function']['name'] === undefined || typeof value['function']['name'] === 'string') &&
    (value['function']['arguments'] === undefined ||
      typeof value['function']['arguments'] === 'string')
  );
}
function requestPayload(op: BridgeOp, value: unknown): boolean {
  if (!object(value)) return false;
  switch (op) {
    case 'boot':
      return (
        keys(
          value,
          ['runtimeUrl', 'wheelsUrl', 'localWheels', 'sources', 'module', 'entry'],
          ['checkpoints', 'framework', 'roles'],
        ) &&
        (value['framework'] === undefined ||
          value['framework'] === 'langgraph' ||
          value['framework'] === 'pydantic-ai' ||
          value['framework'] === 'dspy' ||
          value['framework'] === 'adk') &&
        (value['checkpoints'] === undefined || typeof value['checkpoints'] === 'boolean') &&
        (value['roles'] === undefined ||
          (value['framework'] === 'adk' &&
            Array.isArray(value['roles']) &&
            value['roles'].length <= 256 &&
            value['roles'].every((role: unknown) => text(role) && role.length <= 128))) &&
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
    case 'checkpoint':
      return validCheckpointRequest(value);
    case 'model':
      return (
        keys(value, ['role', 'messages', 'options']) &&
        text(value['role']) &&
        Array.isArray(value['messages']) &&
        value['messages'].every(modelMessage) &&
        object(value['options']) &&
        keys(
          value['options'],
          [],
          ['stop', 'stream', 'tools', 'toolChoice', 'jsonSchema', 'repairAttempt'],
        ) &&
        validModelOption('tools', value['options']['tools'], toolDefinition) &&
        (value['options']['toolChoice'] === undefined ||
          toolChoice(value['options']['toolChoice'])) &&
        validModelOption('jsonSchema', value['options']['jsonSchema']) &&
        (value['options']['repairAttempt'] === undefined ||
          (count(value['options']['repairAttempt']) &&
            value['options']['repairAttempt'] >= 1 &&
            value['options']['jsonSchema'] !== undefined)) &&
        validModelOption('stream', value['options']['stream']) &&
        validModelOption('stop', value['options']['stop'])
      );
    case 'capability':
      return (
        keys(value, ['name', 'input'], ['effectScope', 'tool', 'inner']) &&
        validCapabilityRequest(value) &&
        (value['tool'] === undefined || typeof value['tool'] === 'boolean') &&
        (value['inner'] === undefined || typeof value['inner'] === 'boolean') &&
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
    case 'checkpoint':
      return validCheckpointReply(value);
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
        !keys(value, ['content'], ['usage', 'toolCalls']) ||
        (value['toolCalls'] !== undefined &&
          (!Array.isArray(value['toolCalls']) || !value['toolCalls'].every(validToolCall))) ||
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
      'checkpoint',
    ].includes(value['op'] as string)
  )
    return false;
  const op = value['op'] as BridgeOp;
  if (value['kind'] === 'notify') {
    if (!keys(value, ['v', 'kind', 'id', 'op', 'payload'])) return false;
    const payload = value['payload'];
    if (op === 'model-chunk')
      return (
        object(payload) &&
        keys(payload, ['content'], ['toolCalls']) &&
        typeof payload['content'] === 'string' &&
        (payload['toolCalls'] === undefined ||
          (Array.isArray(payload['toolCalls']) && payload['toolCalls'].every(toolDelta)))
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
  if (typeof value === 'string' && !withinBridgeLimit(value))
    throw new BridgeValidationError('unsupported');
  try {
    if (typeof value !== 'string') throw new BridgeValidationError();
    const parsed = parseJsonText(value);
    if (!valid(parsed)) throw new BridgeValidationError();
    return parsed;
  } catch {
    throw new BridgeValidationError();
  }
}
export function encodeBridge(message: BridgeMessage): string {
  let encoded: string;
  try {
    encoded = encodeValidatedJson(message, () => {
      if (!json(message))
        throw new BridgeValidationError(
          message.kind === 'notify' && message.op === 'stream' ? 'unsupported' : 'invalid',
        );
      if (!valid(message)) throw new BridgeValidationError();
    });
  } catch (error) {
    if (error instanceof BridgeValidationError) throw error;
    throw new BridgeValidationError();
  }
  if (!withinBridgeLimit(encoded)) throw new BridgeValidationError('unsupported');
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
