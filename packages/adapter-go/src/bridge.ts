// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type InteractionRequest, parseInteractionRequest } from '@galaxie/core';
import { adapterFailure } from './errors.js';
import { isRecord, withinBridgeLimit } from './protocol.js';

/** One function call a model asked for, in the OpenAI-compatible shape the Go side sends back. */
export interface BridgeToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface BridgeMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCalls?: readonly BridgeToolCall[];
  readonly tool_call_id?: string;
}

export interface BridgeTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export interface ModelPayload {
  readonly role: string;
  /** The agent whose turn this is; present exactly when `options.stream` is true. */
  readonly author?: string;
  readonly messages: readonly BridgeMessage[];
  readonly options: {
    readonly stop?: readonly string[];
    readonly stream?: boolean;
    readonly tools?: readonly BridgeTool[];
    readonly jsonSchema?: Readonly<Record<string, unknown>>;
  };
}

export interface CapabilityPayload {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly effectScope?: string;
}

export interface ModelReply {
  readonly content: string;
  readonly toolCalls?: readonly BridgeToolCall[];
  readonly usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}

function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const names = Object.keys(value);
  return (
    required.every((name) => names.includes(name)) &&
    names.every((name) => required.includes(name) || optional.includes(name))
  );
}

function plain(value: unknown, seen: Set<object> = new Set(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const ok = children.every((child) => plain(child, seen, depth + 1));
  seen.delete(value);
  return ok;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CALL_ID = /^.{1,128}$/s;

function validToolCall(value: unknown): value is BridgeToolCall {
  return (
    isRecord(value) &&
    keys(value, ['id', 'type', 'function']) &&
    typeof value['id'] === 'string' &&
    CALL_ID.test(value['id']) &&
    value['type'] === 'function' &&
    isRecord(value['function']) &&
    keys(value['function'], ['name', 'arguments']) &&
    typeof value['function']['name'] === 'string' &&
    NAME.test(value['function']['name']) &&
    typeof value['function']['arguments'] === 'string'
  );
}

function validMessage(value: unknown): value is BridgeMessage {
  if (!isRecord(value) || typeof value['content'] !== 'string') return false;
  switch (value['role']) {
    case 'system':
    case 'user':
      return keys(value, ['role', 'content']);
    case 'assistant':
      return (
        keys(value, ['role', 'content'], ['toolCalls']) &&
        (value['toolCalls'] === undefined ||
          (Array.isArray(value['toolCalls']) && value['toolCalls'].every(validToolCall)))
      );
    case 'tool':
      return (
        keys(value, ['role', 'content', 'tool_call_id']) &&
        typeof value['tool_call_id'] === 'string' &&
        CALL_ID.test(value['tool_call_id'])
      );
    default:
      return false;
  }
}

function validTool(value: unknown): value is BridgeTool {
  return (
    isRecord(value) &&
    keys(value, ['type', 'function']) &&
    value['type'] === 'function' &&
    isRecord(value['function']) &&
    keys(value['function'], ['name', 'parameters'], ['description']) &&
    typeof value['function']['name'] === 'string' &&
    NAME.test(value['function']['name']) &&
    (value['function']['description'] === undefined ||
      typeof value['function']['description'] === 'string') &&
    isRecord(value['function']['parameters']) &&
    plain(value['function']['parameters'])
  );
}

function parseFrame(text: string): unknown {
  if (!withinBridgeLimit(text)) throw adapterFailure('unsupported');
  try {
    return JSON.parse(text);
  } catch {
    throw adapterFailure('invalid');
  }
}

/** An agent name is trusted author text: any printable text of bounded length. */
export function validAuthor(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/\p{Cc}/u.test(value)
  );
}

export function parseModelPayload(text: string): ModelPayload {
  const value = parseFrame(text);
  if (
    !isRecord(value) ||
    !keys(value, ['role', 'messages', 'options'], ['author']) ||
    typeof value['role'] !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(value['role']) ||
    !Array.isArray(value['messages']) ||
    value['messages'].length === 0 ||
    !value['messages'].every(validMessage) ||
    !isRecord(value['options']) ||
    !keys(value['options'], [], ['stop', 'stream', 'tools', 'jsonSchema'])
  )
    throw adapterFailure('invalid');
  const options = value['options'];
  if (
    (options['stop'] !== undefined &&
      !(
        Array.isArray(options['stop']) && options['stop'].every((item) => typeof item === 'string')
      )) ||
    (options['stream'] !== undefined && typeof options['stream'] !== 'boolean') ||
    (options['tools'] !== undefined &&
      !(Array.isArray(options['tools']) && options['tools'].every(validTool))) ||
    (options['jsonSchema'] !== undefined &&
      !(isRecord(options['jsonSchema']) && plain(options['jsonSchema'])))
  )
    throw adapterFailure('invalid');
  // A streamed reply is labeled with its agent, and only a streamed reply is.
  if ((value['author'] !== undefined) !== (options['stream'] === true))
    throw adapterFailure('invalid');
  if (value['author'] !== undefined && !validAuthor(value['author']))
    throw adapterFailure('invalid');
  return value as unknown as ModelPayload;
}

export function parseCapabilityPayload(text: string): CapabilityPayload {
  const value = parseFrame(text);
  if (
    !isRecord(value) ||
    !keys(value, ['name', 'input'], ['effectScope']) ||
    typeof value['name'] !== 'string' ||
    value['name'].length === 0 ||
    !isRecord(value['input']) ||
    !plain(value['input']) ||
    (value['effectScope'] !== undefined &&
      !(typeof value['effectScope'] === 'string' && value['effectScope'].length <= 512))
  )
    throw adapterFailure('invalid');
  return value as unknown as CapabilityPayload;
}

export function encodeReply(value: unknown): string {
  if (!plain(value)) throw adapterFailure('invalid');
  const text = JSON.stringify(value);
  if (!withinBridgeLimit(text)) throw adapterFailure('unsupported');
  return text;
}

/** A run that stopped to wait for the user: the interaction to show and the tools it holds. */
export interface BridgePause {
  readonly interactionId: string;
  readonly request: InteractionRequest;
}

export type RunResult =
  | { readonly ok: true; readonly output: string; readonly paused?: undefined }
  | { readonly ok: true; readonly paused: BridgePause }
  | { readonly ok: false; readonly code: string };

const INTERACTION_ID = /^[0-9a-f]{64}$/;

function parsePause(value: unknown): BridgePause {
  if (
    !isRecord(value) ||
    !keys(value, ['interactionId', 'request']) ||
    typeof value['interactionId'] !== 'string' ||
    !INTERACTION_ID.test(value['interactionId'])
  )
    throw adapterFailure('invalid');
  const request = parseInteractionRequest(value['request']);
  if (request === undefined) throw adapterFailure('invalid');
  return { interactionId: value['interactionId'], request };
}

export function parseRunResult(text: string): RunResult {
  const value = parseFrame(text);
  if (isRecord(value) && value['ok'] === true && keys(value, ['ok'], ['output', 'paused'])) {
    if (value['paused'] !== undefined) {
      if (value['output'] !== undefined && value['output'] !== '') throw adapterFailure('invalid');
      return { ok: true, paused: parsePause(value['paused']) };
    }
    if (value['output'] === undefined || typeof value['output'] === 'string')
      return { ok: true, output: (value['output'] as string | undefined) ?? '' };
  }
  if (
    isRecord(value) &&
    value['ok'] === false &&
    keys(value, ['ok', 'code']) &&
    typeof value['code'] === 'string'
  )
    return { ok: false, code: value['code'] };
  throw adapterFailure('invalid');
}
