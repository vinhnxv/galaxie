// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type PendingInteraction, parseInteractionRequest } from '@galaxie-ai/core';
import { createEvent, type Event } from '@google/adk';
import { failure } from './errors.js';
import type { AdkPendingRequest, PausedCall } from './interaction.js';

/** Checkpoint types the byte-record port stores for this executor (KTD8). */
export const SESSION_TYPE = 'adk.session/v1';
export const STATE_TYPE = 'galaxie.adk-state/v1';
export const EXECUTOR = 'adk-js';

/** A stored record this large is refused rather than written (fixed `unsupported`). */
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const KEY_BYTES = 32;
const REVISION = /^\d{20}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** Everything the adapter keeps for one conversation between runs. */
export interface SessionRecord {
  readonly events: readonly Event[];
  /** The next pause ordinal; the stored pause, if any, used the one before it. */
  readonly ordinal: number;
  readonly pause?: {
    readonly interaction: PendingInteraction;
    readonly calls: readonly PausedCall[];
  };
}

export interface StoredSession extends SessionRecord {
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

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The only top-level fields ADK 2.3.0 sets on the events a supported agent tree produces. */
const EVENT_KEYS = [
  'id',
  'invocationId',
  'author',
  'actions',
  'longRunningToolIds',
  'branch',
  'timestamp',
  'content',
  'customMetadata',
  'usageMetadata',
  'finishReason',
  'errorCode',
  'errorMessage',
  'turnComplete',
  'interrupted',
] as const;

const ACTION_KEYS = [
  'skipSummarization',
  'stateDelta',
  'artifactDelta',
  'transferToAgent',
  'escalate',
  'requestedAuthConfigs',
  'requestedToolConfirmations',
  'agentState',
  'endOfAgent',
] as const;

function validPart(part: unknown): boolean {
  if (
    !plain(part) ||
    !only(part, ['text', 'thought', 'thoughtSignature', 'functionCall', 'functionResponse'])
  )
    return false;
  const call = part['functionCall'];
  if (
    call !== undefined &&
    !(
      plain(call) &&
      only(call, ['id', 'name', 'args']) &&
      text(call['name']) &&
      (call['args'] === undefined || plain(call['args']))
    )
  )
    return false;
  const response = part['functionResponse'];
  return (
    response === undefined ||
    (plain(response) && only(response, ['id', 'name', 'response']) && text(response['name']))
  );
}

/** A closed shape check: partial events and binary or file parts are never stored (KTD8). */
function validEvent(event: unknown): event is Event {
  if (!plain(event) || !only(event, EVENT_KEYS)) return false;
  if (!text(event['id']) || typeof event['timestamp'] !== 'number') return false;
  if (event['invocationId'] !== undefined && typeof event['invocationId'] !== 'string')
    return false;
  if (event['author'] !== undefined && typeof event['author'] !== 'string') return false;
  const metadata = event['customMetadata'];
  if (metadata !== undefined && !plain(metadata)) return false;
  const running = event['longRunningToolIds'];
  if (running !== undefined && !(Array.isArray(running) && running.every(text))) return false;
  const actions = event['actions'];
  if (!plain(actions) || !only(actions, ACTION_KEYS)) return false;
  if (actions['agentState'] !== undefined || actions['endOfAgent'] !== undefined) return false;
  const content = event['content'];
  if (content === undefined) return true;
  if (!plain(content) || !only(content, ['role', 'parts'])) return false;
  const parts = content['parts'];
  return parts === undefined || (Array.isArray(parts) && parts.every(validPart));
}

function validRequest(value: unknown): value is AdkPendingRequest {
  if (!plain(value) || !text(value['tool']) || !plain(value['args'])) return false;
  if (value['kind'] === 'long-running') return only(value, ['kind', 'tool', 'args']);
  return (
    value['kind'] === 'confirmation' &&
    only(value, ['kind', 'tool', 'args', 'hint']) &&
    (value['hint'] === undefined || typeof value['hint'] === 'string')
  );
}

function validCall(value: unknown): value is PausedCall {
  if (!plain(value) || !only(value, ['id', 'name', 'request', 'gated'])) return false;
  const gated = value['gated'];
  return (
    text(value['id']) &&
    text(value['name']) &&
    validRequest(value['request']) &&
    (gated === undefined ||
      (plain(gated) && only(gated, ['id', 'name']) && text(gated['id']) && text(gated['name'])))
  );
}

function callsOf(
  events: readonly Event[],
): Map<string, { name: string | undefined; args: unknown }> {
  const calls = new Map<string, { name: string | undefined; args: unknown }>();
  for (const event of events)
    for (const part of event.content?.parts ?? [])
      if (part.functionCall?.id !== undefined)
        calls.set(part.functionCall.id, {
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
  return calls;
}

/** Whether a pause names calls that the stamped events really hold, with the same arguments. */
function pauseMatches(calls: readonly PausedCall[], events: readonly Event[]): boolean {
  const known = callsOf(events);
  return calls.every((call) => {
    const target = call.gated ?? call;
    const stored = known.get(target.id);
    return (
      known.has(call.id) &&
      stored?.name === target.name &&
      JSON.stringify(stored.args ?? {}) === JSON.stringify(call.request.args)
    );
  });
}

/** The single defined author shared by every paused call and its gated call, when present. */
export function pauseAuthor(
  calls: readonly PausedCall[],
  events: readonly Event[],
): string | undefined {
  const ids = new Set(
    calls.flatMap((call) => [call.id, ...(call.gated === undefined ? [] : [call.gated.id])]),
  );
  const matched = new Set<string>();
  let author: string | undefined;
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      const id = part.functionCall?.id;
      if (id === undefined || !ids.has(id)) continue;
      if (event.author === undefined || (author !== undefined && event.author !== author))
        return undefined;
      author = event.author;
      matched.add(id);
    }
  }
  return matched.size === ids.size ? author : undefined;
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_RECORD_BYTES) throw failure('unsupported');
  return bytes;
}

function parse(bytes: unknown): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RECORD_BYTES)
    throw failure('unrecoverable');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw failure('unrecoverable');
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The bytes of one record: the checkpoint holds the conversation, the metadata the integrity key. */
export function encodeRecord(
  sessionId: string,
  record: SessionRecord,
  key: Uint8Array,
): { checkpoint: Uint8Array; metadata: Uint8Array } {
  const events = record.events as readonly unknown[];
  if (events.length > MAX_EVENTS || !events.every(validEvent)) throw failure('unsupported');
  const checkpoint = jsonBytes({
    v: 1,
    conversationId: sessionId,
    ordinal: record.ordinal,
    events: record.events,
    ...(record.pause === undefined ? {} : { pause: record.pause }),
  });
  return { checkpoint, metadata: jsonBytes({ v: 1, key: base64(key) }) };
}

/**
 * Reads one stored record. Every check fails `unrecoverable`: a corrupt or spliced record never
 * reaches ADK, and the other sessions stay readable.
 */
export function decodeRecord(
  sessionId: string,
  digest: (value: unknown) => Promise<string>,
  stored: {
    readonly id: unknown;
    readonly checkpoint: { readonly type: unknown; readonly bytes: unknown };
    readonly metadata: { readonly type: unknown; readonly bytes: unknown };
  },
): Promise<StoredSession> {
  return (async () => {
    const { id, checkpoint, metadata } = stored;
    if (
      typeof id !== 'string' ||
      !REVISION.test(id) ||
      Number(id) < 1 ||
      checkpoint.type !== SESSION_TYPE ||
      metadata.type !== STATE_TYPE
    )
      throw failure('unrecoverable');
    const state = parse(metadata.bytes);
    const body = parse(checkpoint.bytes);
    if (!plain(state) || !only(state, ['v', 'key']) || state['v'] !== 1)
      throw failure('unrecoverable');
    if (
      !plain(body) ||
      !only(body, ['v', 'conversationId', 'ordinal', 'events', 'pause']) ||
      body['v'] !== 1 ||
      body['conversationId'] !== sessionId ||
      !Number.isSafeInteger(body['ordinal']) ||
      (body['ordinal'] as number) < 0 ||
      !Array.isArray(body['events']) ||
      body['events'].length > MAX_EVENTS ||
      !body['events'].every(validEvent)
    )
      throw failure('unrecoverable');
    let key: Uint8Array;
    try {
      if (typeof state['key'] !== 'string') throw new Error();
      key = Uint8Array.from(atob(state['key']), (char) => char.charCodeAt(0));
    } catch {
      throw failure('unrecoverable');
    }
    if (key.byteLength !== KEY_BYTES) throw failure('unrecoverable');
    const events = (body['events'] as Event[]).map((event) => createEvent(event));
    const ordinal = body['ordinal'] as number;
    const pause: unknown = body['pause'];
    let restored: SessionRecord['pause'];
    if (pause !== undefined) {
      if (!plain(pause) || !only(pause, ['interaction', 'calls']) || !Array.isArray(pause['calls']))
        throw failure('unrecoverable');
      const interaction: unknown = pause['interaction'];
      if (!plain(interaction) || ordinal < 1) throw failure('unrecoverable');
      const { interactionId, ...request } = interaction;
      const parsed = parseInteractionRequest(request);
      if (
        parsed === undefined ||
        typeof interactionId !== 'string' ||
        !DIGEST.test(interactionId) ||
        interactionId !== (await digest([sessionId, ordinal - 1])) ||
        pause['calls'].length === 0 ||
        !pause['calls'].every(validCall)
      )
        throw failure('unrecoverable');
      const calls = pause['calls'] as PausedCall[];
      if (!pauseMatches(calls, events)) throw failure('unrecoverable');
      restored = { interaction: interaction as unknown as PendingInteraction, calls };
    }
    return {
      events,
      ordinal,
      ...(restored === undefined ? {} : { pause: restored }),
      key,
      revision: Number(id),
    };
  })();
}

/** The text-bearing values of a record, which core registers as private before replay (KTD8). */
export function restoredContent(record: SessionRecord): Json[] {
  const values: Json[] = [];
  for (const event of record.events) {
    if (event.errorMessage !== undefined) values.push(event.errorMessage);
    for (const value of Object.values(event.actions?.stateDelta ?? {})) values.push(value as Json);
    for (const part of event.content?.parts ?? []) {
      if (part.text !== undefined) values.push(part.text);
      if (part.functionCall?.args !== undefined) values.push(part.functionCall.args as Json);
      if (part.functionResponse?.response !== undefined)
        values.push(part.functionResponse.response as Json);
    }
  }
  if (record.pause !== undefined)
    values.push(JSON.parse(JSON.stringify(record.pause.interaction)) as Json);
  for (const call of record.pause?.calls ?? []) values.push(call.request.args as Json);
  return values;
}

/** The checkpoint ID of a revision: zero padded so that string order is revision order. */
export const revisionId = (revision: number): string => String(revision).padStart(20, '0');
