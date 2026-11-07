// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  encodeValidatedJson,
  hasOnlyKeys,
  isJsonValue,
  parseJsonText,
  validBridgeTool,
  validBridgeToolCall,
  validCapabilityRequest,
  validChatMessage,
  validModelOption,
} from '@galaxie/adapter-kit';
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
  return hasOnlyKeys(value, required, optional, true);
}

function plain(value: unknown): boolean {
  return isJsonValue(value, { plainObjects: false, maxDepth: 64, arrayProperties: false });
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CALL_ID = /^.{1,128}$/s;

function validName(value: unknown): boolean {
  return typeof value === 'string' && NAME.test(value);
}
function validCallId(value: unknown): boolean {
  return typeof value === 'string' && CALL_ID.test(value);
}
function validToolCall(value: unknown): value is BridgeToolCall {
  return validBridgeToolCall(value, validName, validCallId, true);
}
function validMessage(value: unknown): value is BridgeMessage {
  return validChatMessage(value, validToolCall, validCallId, true);
}
function validTool(value: unknown): value is BridgeTool {
  return validBridgeTool(value, {
    name: validName,
    json: plain,
    strict: false,
    descriptionFirst: true,
    enumerableRequired: true,
  });
}

function parseFrame(text: string): unknown {
  if (!withinBridgeLimit(text)) throw adapterFailure('unsupported');
  try {
    return parseJsonText(text);
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
    !validModelOption('stop', options['stop']) ||
    !validModelOption('stream', options['stream']) ||
    !validModelOption('tools', options['tools'], validTool) ||
    !validModelOption('jsonSchema', options['jsonSchema'], plain)
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
    !validCapabilityRequest(value, plain, true) ||
    (value['effectScope'] !== undefined &&
      !(typeof value['effectScope'] === 'string' && value['effectScope'].length <= 512))
  )
    throw adapterFailure('invalid');
  return value as unknown as CapabilityPayload;
}

export function encodeReply(value: unknown): string {
  const text = encodeValidatedJson(value, () => {
    if (!plain(value)) throw adapterFailure('invalid');
  });
  if (!withinBridgeLimit(text)) throw adapterFailure('unsupported');
  return text;
}

/** A run that stopped to wait for the user: the interaction to show and the ID that answers it. */
export interface BridgePause {
  readonly interactionId: string;
  readonly request: InteractionRequest;
}

/** A conversation record the program returns when the host asked to persist: a JSON object. */
export type ConversationRecord = Readonly<Record<string, unknown>>;

export type RunResult =
  | {
      readonly ok: true;
      readonly output: string;
      readonly paused?: undefined;
      readonly record?: ConversationRecord;
    }
  | { readonly ok: true; readonly paused: BridgePause; readonly record?: ConversationRecord }
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
  if (
    isRecord(value) &&
    value['ok'] === true &&
    keys(value, ['ok'], ['output', 'paused', 'record'])
  ) {
    const record: unknown = value['record'];
    if (record !== undefined && !isRecord(record)) throw adapterFailure('invalid');
    const stored = record === undefined ? {} : { record: record as ConversationRecord };
    if (value['paused'] !== undefined) {
      if (value['output'] !== undefined && value['output'] !== '') throw adapterFailure('invalid');
      return { ok: true, paused: parsePause(value['paused']), ...stored };
    }
    if (value['output'] === undefined || typeof value['output'] === 'string')
      return { ok: true, output: (value['output'] as string | undefined) ?? '', ...stored };
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
