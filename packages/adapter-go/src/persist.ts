// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type PendingInteraction, parseInteractionRequest } from '@galaxie/core';
import type { ConversationRecord } from './bridge.js';
import { adapterFailure } from './errors.js';

export const SESSION_TYPE: string = 'adk-go.session/v1';
export const STATE_TYPE: string = 'galaxie.adk-go-state/v1';
export const EXECUTOR: string = 'adk-go';

/**
 * A record is refused above this size. It matches the Go side, which stops a run before the next
 * model or tool call once the record would outgrow it: a bridge message is capped at 1 MiB and the
 * record shares it with the rest of the request or result.
 */
export const MAX_RECORD_BYTES: number = 512 * 1024;
const MAX_EVENTS = 10_000;
const KEY_BYTES = 32;
const REVISION = /^\d{20}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONVERSATION = /^g[0-9]{1,9}$/;

/** What the page keeps for one conversation between runs. */
export interface StoredConversation {
  /** The record exactly as the program returned it. */
  readonly record: ConversationRecord;
  /** The pause the conversation waits on, if any. */
  readonly pause?: PendingInteraction;
  /** Where stream markers continue, so a resumed run never repeats an index. */
  readonly position: number;
  readonly conversation: string;
  readonly key: Uint8Array;
  readonly revision: number;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function only(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

const encoder = new TextEncoder();

export function recordBytes(record: ConversationRecord): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(record));
  if (bytes.byteLength > MAX_RECORD_BYTES) throw adapterFailure('unsupported');
  return bytes;
}

function parse(bytes: unknown): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RECORD_BYTES)
    throw adapterFailure('unrecoverable');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw adapterFailure('unrecoverable');
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The integrity tag of a checkpoint: HMAC-SHA-256 over the session, the stream position and the
 * record bytes. The key sits beside the record, so the tag detects a corrupt, truncated, spliced
 * or half-edited record; it does not stop an attacker who can rewrite both.
 */
async function tagOf(
  key: Uint8Array,
  sessionId: string,
  position: number,
  checkpoint: Uint8Array,
): Promise<string> {
  const head = encoder.encode(`adk-go|${sessionId}|${position}|`);
  const message = new Uint8Array(head.byteLength + checkpoint.byteLength);
  message.set(head, 0);
  message.set(checkpoint, head.byteLength);
  const imported = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', imported, message)));
}

export function newKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export async function encodeStored(
  sessionId: string,
  record: ConversationRecord,
  position: number,
  key: Uint8Array,
): Promise<{ checkpoint: Uint8Array; metadata: Uint8Array }> {
  if (!Number.isSafeInteger(position) || position < 0) throw adapterFailure('invalid');
  const checkpoint = recordBytes(record);
  const metadata = encoder.encode(
    JSON.stringify({
      v: 1,
      key: base64(key),
      position,
      mac: await tagOf(key, sessionId, position, checkpoint),
    }),
  );
  return { checkpoint, metadata };
}

function pauseOf(body: Record<string, unknown>): PendingInteraction | undefined {
  const pause: unknown = body['pause'];
  if (pause === undefined) return undefined;
  if (
    !plain(pause) ||
    !only(pause, ['id', 'request', 'calls']) ||
    typeof pause['id'] !== 'string' ||
    !DIGEST.test(pause['id']) ||
    !Array.isArray(pause['calls']) ||
    pause['calls'].length === 0 ||
    typeof body['ordinal'] !== 'number' ||
    body['ordinal'] < 1
  )
    throw adapterFailure('unrecoverable');
  const request = parseInteractionRequest(pause['request']);
  if (request === undefined) throw adapterFailure('unrecoverable');
  return { interactionId: pause['id'], ...request } as PendingInteraction;
}

/**
 * Reads one stored conversation. Every check fails `unrecoverable`: a corrupt or spliced record
 * never reaches the program, and the other sessions stay readable.
 */
export async function decodeStored(
  sessionId: string,
  stored: {
    readonly id: unknown;
    readonly checkpoint: { readonly type: unknown; readonly bytes: unknown };
    readonly metadata: { readonly type: unknown; readonly bytes: unknown };
  },
): Promise<StoredConversation> {
  const { id, checkpoint, metadata } = stored;
  if (
    typeof id !== 'string' ||
    !REVISION.test(id) ||
    Number(id) < 1 ||
    checkpoint.type !== SESSION_TYPE ||
    metadata.type !== STATE_TYPE
  )
    throw adapterFailure('unrecoverable');
  const state = parse(metadata.bytes);
  if (
    !plain(state) ||
    !only(state, ['v', 'key', 'position', 'mac']) ||
    state['v'] !== 1 ||
    typeof state['key'] !== 'string' ||
    typeof state['mac'] !== 'string' ||
    !DIGEST.test(state['mac']) ||
    !Number.isSafeInteger(state['position']) ||
    (state['position'] as number) < 0
  )
    throw adapterFailure('unrecoverable');
  let key: Uint8Array;
  try {
    key = unbase64(state['key']);
  } catch {
    throw adapterFailure('unrecoverable');
  }
  if (key.byteLength !== KEY_BYTES) throw adapterFailure('unrecoverable');
  const bytes = checkpoint.bytes;
  const body = parse(bytes);
  const position = state['position'] as number;
  if (state['mac'] !== (await tagOf(key, sessionId, position, bytes as Uint8Array)))
    throw adapterFailure('unrecoverable');
  if (
    !plain(body) ||
    !only(body, ['v', 'conversation', 'ordinal', 'counter', 'memory', 'events', 'pause']) ||
    body['v'] !== 1 ||
    typeof body['conversation'] !== 'string' ||
    !CONVERSATION.test(body['conversation']) ||
    !Number.isSafeInteger(body['ordinal']) ||
    (body['ordinal'] as number) < 0 ||
    !Number.isSafeInteger(body['counter']) ||
    (body['counter'] as number) < 0 ||
    !plain(body['memory']) ||
    !Array.isArray(body['events']) ||
    body['events'].length > MAX_EVENTS ||
    !body['events'].every(plain)
  )
    throw adapterFailure('unrecoverable');
  const pause = pauseOf(body);
  return {
    record: body,
    ...(pause === undefined ? {} : { pause }),
    position,
    conversation: body['conversation'],
    key,
    revision: Number(id),
  };
}

/**
 * The text-bearing values of a record, which core registers as private before the program sees
 * them: event text, call arguments and responses, state values, and the pending request. The
 * integrity key, counters and identifiers are never registered.
 */
export function restoredContent(record: ConversationRecord): Json[] {
  const values: Json[] = [];
  const events: unknown = record['events'];
  if (!Array.isArray(events)) throw adapterFailure('unrecoverable');
  for (const event of events) {
    if (!plain(event)) throw adapterFailure('unrecoverable');
    const actions = event['actions'];
    if (plain(actions)) {
      if (plain(actions['stateDelta']))
        for (const value of Object.values(actions['stateDelta'])) values.push(value as Json);
      const confirmations = actions['requestedToolConfirmations'];
      if (plain(confirmations))
        for (const confirmation of Object.values(confirmations)) values.push(confirmation as Json);
    }
    const content = event['content'];
    if (!plain(content)) continue;
    const parts: unknown = content['parts'];
    if (!Array.isArray(parts)) throw adapterFailure('unrecoverable');
    for (const part of parts) {
      if (!plain(part)) throw adapterFailure('unrecoverable');
      if (typeof part['text'] === 'string') values.push(part['text']);
      const call = part['functionCall'];
      if (plain(call) && call['args'] !== undefined) values.push(call['args'] as Json);
      const response = part['functionResponse'];
      if (plain(response) && response['response'] !== undefined)
        values.push(response['response'] as Json);
    }
  }
  const pause = record['pause'];
  if (plain(pause)) {
    values.push(pause['request'] as Json);
    if (Array.isArray(pause['calls']))
      for (const call of pause['calls']) if (plain(call)) values.push(call['request'] as Json);
  }
  return values;
}

export const revisionId = (revision: number): string => String(revision).padStart(20, '0');
