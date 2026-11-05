// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelUnavailableReason } from '../errors.js';
import { parseModelRecord, type TransformersModelRecord } from './model-record.js';

/**
 * The closed page-to-Worker protocol (ADR-0021 decision 4). Both ends validate every message and
 * ignore what does not match. Prompts and replies travel only in `generate` and `chunk`; failures
 * cross as fixed codes and never as engine text.
 */

export const maxMessages = 256;
export const maxTextLength = 1_048_576;
const maxToolCalls = 16;
const maxTools = 64;
const maxJsonNodes = 20_000;
const maxJsonDepth = 24;
const maxJsonKeyLength = 256;
const maxTokensLimit = 1_000_000;
const maxLabelLength = 128;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type ProtocolRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ProtocolToolCall {
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ProtocolMessage {
  readonly role: ProtocolRole;
  readonly content: string;
  readonly toolCalls?: readonly ProtocolToolCall[];
}

export interface GenerateRequest {
  readonly messages: readonly ProtocolMessage[];
  /** Tool declarations in the OpenAI function shape, passed to the chat template as `tools`. */
  readonly tools?: readonly JsonObject[];
  readonly maxTokens: number;
  readonly temperature: number;
  readonly jsonSchema?: JsonObject;
}

export type FinishReason = 'stop' | 'length' | 'abort';
export type FailureCode = 'unavailable' | 'unreachable' | 'invalid' | 'unsupported' | 'provider';
export type LoadPhase = 'download' | 'verify' | 'load';

export interface DeviceReport {
  readonly backend: 'webgpu' | 'wasm';
  readonly thread: 'worker';
  readonly vendor: string;
  readonly architecture: string;
}

export type ToWorker =
  | {
      readonly type: 'load';
      readonly record: TransformersModelRecord;
      readonly allowDownload: boolean;
    }
  | { readonly type: 'generate'; readonly id: number; readonly request: GenerateRequest }
  | { readonly type: 'abort'; readonly id: number }
  | { readonly type: 'dispose' };

export type FromWorker =
  | { readonly type: 'ready'; readonly device: DeviceReport }
  | {
      readonly type: 'progress';
      readonly phase: LoadPhase;
      readonly fraction: number;
      readonly elapsedSeconds: number;
    }
  | { readonly type: 'chunk'; readonly id: number; readonly text: string }
  | {
      readonly type: 'done';
      readonly id: number;
      readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
      readonly finishReason: FinishReason;
    }
  | {
      readonly type: 'failed';
      readonly id?: number;
      readonly code: FailureCode;
      readonly reason?: ModelUnavailableReason;
    };

/** Every reason the Worker may report; the list is closed so engine text cannot be smuggled in. */
export const unavailableReasons: readonly ModelUnavailableReason[] = [
  'no_webgpu',
  'no_adapter',
  'no_shader_f16',
  'adapter_limits',
  'device_lost',
  'integrity',
  'worker_failed',
  'load_failed',
  'disposed',
  'download_failed',
];
const failureCodes: readonly string[] = [
  'unavailable',
  'unreachable',
  'invalid',
  'unsupported',
  'provider',
];
const roles: readonly string[] = ['system', 'user', 'assistant', 'tool'];

type Fields = Record<string, unknown>;

function plain(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function only(value: Fields, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function count(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function text(value: unknown, max = maxTextLength): value is string {
  return typeof value === 'string' && value.length <= max;
}

function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A plain JSON tree within fixed depth, node and string limits. */
function boundedJson(value: unknown): value is JsonValue {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxJsonNodes || depth > maxJsonDepth) return false;
    if (entry === null || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (typeof entry === 'string') return entry.length <= maxTextLength;
    if (Array.isArray(entry)) return (entry as unknown[]).every((item) => visit(item, depth + 1));
    if (!plain(entry)) return false;
    return Object.entries(entry).every(
      ([key, item]) => key.length <= maxJsonKeyLength && visit(item, depth + 1),
    );
  };
  return visit(value, 0);
}

function jsonObject(value: unknown): value is JsonObject {
  return plain(value) && boundedJson(value);
}

function parseToolCall(value: unknown): ProtocolToolCall | undefined {
  if (!plain(value) || !only(value, ['name', 'arguments'])) return undefined;
  const { name, arguments: args } = value;
  if (!text(name, maxLabelLength) || name === '' || !jsonObject(args)) return undefined;
  return { name, arguments: args };
}

function parseMessage(value: unknown): ProtocolMessage | undefined {
  if (!plain(value) || !only(value, ['role', 'content', 'toolCalls'])) return undefined;
  const { role, content, toolCalls } = value;
  if (typeof role !== 'string' || !roles.includes(role) || !text(content)) return undefined;
  if (toolCalls === undefined) return { role: role as ProtocolRole, content };
  if (role !== 'assistant' || !Array.isArray(toolCalls) || toolCalls.length > maxToolCalls)
    return undefined;
  const calls: ProtocolToolCall[] = [];
  for (const entry of toolCalls as unknown[]) {
    const call = parseToolCall(entry);
    if (call === undefined) return undefined;
    calls.push(call);
  }
  return { role, content, toolCalls: calls };
}

function parseGenerateRequest(value: unknown): GenerateRequest | undefined {
  if (
    !plain(value) ||
    !only(value, ['messages', 'tools', 'maxTokens', 'temperature', 'jsonSchema'])
  )
    return undefined;
  const { messages: list, tools: toolList, maxTokens, temperature, jsonSchema } = value;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > maxMessages ||
    !count(maxTokens, 1, maxTokensLimit) ||
    typeof temperature !== 'number' ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  )
    return undefined;
  const messages: ProtocolMessage[] = [];
  for (const entry of list as unknown[]) {
    const message = parseMessage(entry);
    if (message === undefined) return undefined;
    messages.push(message);
  }
  let tools: JsonObject[] | undefined;
  if (toolList !== undefined) {
    if (!Array.isArray(toolList) || toolList.length > maxTools) return undefined;
    tools = [];
    for (const entry of toolList as unknown[]) {
      if (!jsonObject(entry)) return undefined;
      tools.push(entry);
    }
  }
  if (jsonSchema !== undefined && !jsonObject(jsonSchema)) return undefined;
  return {
    messages,
    ...(tools === undefined ? {} : { tools }),
    maxTokens,
    temperature,
    ...(jsonSchema === undefined ? {} : { jsonSchema }),
  };
}

/** Validates a message the page sends; anything that does not match is `undefined`. */
export function parseToWorker(value: unknown): ToWorker | undefined {
  if (!plain(value)) return undefined;
  switch (value['type']) {
    case 'load': {
      if (!only(value, ['type', 'record', 'allowDownload'])) return undefined;
      if (typeof value['allowDownload'] !== 'boolean') return undefined;
      try {
        return {
          type: 'load',
          record: parseModelRecord(value['record']),
          allowDownload: value['allowDownload'],
        };
      } catch {
        return undefined;
      }
    }
    case 'generate': {
      if (
        !only(value, ['type', 'id', 'request']) ||
        !count(value['id'], 1, Number.MAX_SAFE_INTEGER)
      )
        return undefined;
      const request = parseGenerateRequest(value['request']);
      return request === undefined ? undefined : { type: 'generate', id: value['id'], request };
    }
    case 'abort':
      return only(value, ['type', 'id']) && count(value['id'], 1, Number.MAX_SAFE_INTEGER)
        ? { type: 'abort', id: value['id'] }
        : undefined;
    case 'dispose':
      return only(value, ['type']) ? { type: 'dispose' } : undefined;
    default:
      return undefined;
  }
}

function parseDevice(value: unknown): DeviceReport | undefined {
  if (!plain(value) || !only(value, ['backend', 'thread', 'vendor', 'architecture']))
    return undefined;
  const { backend, thread, vendor, architecture } = value;
  if (
    (backend !== 'webgpu' && backend !== 'wasm') ||
    thread !== 'worker' ||
    !text(vendor, maxLabelLength) ||
    !text(architecture, maxLabelLength)
  )
    return undefined;
  return { backend, thread, vendor, architecture };
}

/** Validates a message the Worker sends; anything that does not match is `undefined`. */
export function parseFromWorker(value: unknown): FromWorker | undefined {
  if (!plain(value)) return undefined;
  switch (value['type']) {
    case 'ready': {
      if (!only(value, ['type', 'device'])) return undefined;
      const device = parseDevice(value['device']);
      return device === undefined ? undefined : { type: 'ready', device };
    }
    case 'progress': {
      const { phase, fraction, elapsedSeconds } = value;
      if (
        !only(value, ['type', 'phase', 'fraction', 'elapsedSeconds']) ||
        (phase !== 'download' && phase !== 'verify' && phase !== 'load') ||
        !unit(fraction) ||
        typeof elapsedSeconds !== 'number' ||
        !Number.isFinite(elapsedSeconds) ||
        elapsedSeconds < 0
      )
        return undefined;
      return { type: 'progress', phase, fraction, elapsedSeconds };
    }
    case 'chunk':
      return only(value, ['type', 'id', 'text']) &&
        count(value['id'], 1, Number.MAX_SAFE_INTEGER) &&
        text(value['text'])
        ? { type: 'chunk', id: value['id'], text: value['text'] }
        : undefined;
    case 'done': {
      const { id, usage, finishReason } = value;
      if (
        !only(value, ['type', 'id', 'usage', 'finishReason']) ||
        !count(id, 1, Number.MAX_SAFE_INTEGER) ||
        !plain(usage) ||
        !only(usage, ['promptTokens', 'completionTokens']) ||
        !count(usage['promptTokens'], 0, Number.MAX_SAFE_INTEGER) ||
        !count(usage['completionTokens'], 0, Number.MAX_SAFE_INTEGER) ||
        (finishReason !== 'stop' && finishReason !== 'length' && finishReason !== 'abort')
      )
        return undefined;
      return {
        type: 'done',
        id,
        usage: { promptTokens: usage['promptTokens'], completionTokens: usage['completionTokens'] },
        finishReason,
      };
    }
    case 'failed': {
      const { id, code, reason } = value;
      if (
        !only(value, ['type', 'id', 'code', 'reason']) ||
        typeof code !== 'string' ||
        !failureCodes.includes(code) ||
        (id !== undefined && !count(id, 1, Number.MAX_SAFE_INTEGER)) ||
        (reason !== undefined &&
          (code !== 'unavailable' ||
            typeof reason !== 'string' ||
            !unavailableReasons.includes(reason as ModelUnavailableReason)))
      )
        return undefined;
      return {
        type: 'failed',
        ...(id === undefined ? {} : { id }),
        code: code as FailureCode,
        ...(reason === undefined ? {} : { reason: reason as ModelUnavailableReason }),
      };
    }
    default:
      return undefined;
  }
}
