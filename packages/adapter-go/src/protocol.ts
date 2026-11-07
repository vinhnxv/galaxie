// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  encodeJsonText,
  isRecord,
  MAX_BRIDGE_BYTES,
  parseJsonText,
  withinBridgeLimit,
} from '@galaxie/adapter-kit';

export { isRecord, MAX_BRIDGE_BYTES, withinBridgeLimit };

/** The executor id the host selects this adapter by. */
export const GO_EXECUTOR_ID = 'adk-go';

export const MAX_WASM_BYTES: number = 64 * 1024 * 1024;

/** The Go module the host reviewed: where to fetch it and what it must be. */
export interface GoWasmReference {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BootMessage {
  readonly v: 1;
  readonly kind: 'boot';
  readonly wasm: GoWasmReference;
}

/** A dependency version and checksum as recorded in the Go binary. */
export interface GoModuleInfo {
  readonly version: string;
  readonly sum: string;
}

/** What the program reports in the ready handshake; the page compares it with the reviewed lock. */
export interface GoBuildInfo {
  readonly go: string;
  readonly adk: GoModuleInfo;
  readonly genai: GoModuleInfo;
}

export type BridgeOp = 'model' | 'capability';

export type HostMessage =
  | BootMessage
  | { readonly v: 1; readonly kind: 'run'; readonly runId: string; readonly request: string }
  | { readonly v: 1; readonly kind: 'cancel'; readonly runId: string }
  | {
      readonly v: 1;
      readonly kind: 'reply';
      readonly runId: string;
      readonly id: string;
      readonly ok: true;
      readonly payload: string;
    }
  | {
      readonly v: 1;
      readonly kind: 'reply';
      readonly runId: string;
      readonly id: string;
      readonly ok: false;
      readonly code: string;
    };

export type WorkerMessage =
  | {
      readonly v: 1;
      readonly kind: 'ready';
      readonly coldStartMs: number;
      readonly build?: GoBuildInfo;
    }
  | { readonly v: 1; readonly kind: 'failed' }
  | { readonly v: 1; readonly kind: 'exit'; readonly code: number }
  | {
      readonly v: 1;
      readonly kind: 'call';
      readonly runId: string;
      readonly id: string;
      readonly op: BridgeOp;
      readonly payload: string;
    }
  | { readonly v: 1; readonly kind: 'done'; readonly runId: string; readonly result: string };

export function failedRun(code: string): string {
  return JSON.stringify({ ok: false, code });
}

export function validWasmReference(value: unknown): value is GoWasmReference {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value['url'] === 'string' &&
    typeof value['sha256'] === 'string' &&
    /^[0-9a-f]{64}$/.test(value['sha256']) &&
    typeof value['bytes'] === 'number' &&
    Number.isSafeInteger(value['bytes']) &&
    value['bytes'] > 0 &&
    value['bytes'] <= MAX_WASM_BYTES
  );
}

/** Accepts only an http(s) URL without credentials. */
export function validUrl(value: unknown, base?: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && withinBridgeLimit(value);
}

function validModule(value: unknown): value is GoModuleInfo {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value['version'] === 'string' &&
    typeof value['sum'] === 'string'
  );
}

export function validBuildInfo(value: unknown): value is GoBuildInfo {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value['go'] === 'string' &&
    validModule(value['adk']) &&
    validModule(value['genai'])
  );
}

export function sameBuildInfo(left: GoBuildInfo, right: GoBuildInfo): boolean {
  return (
    left.go === right.go &&
    left.adk.version === right.adk.version &&
    left.adk.sum === right.adk.sum &&
    left.genai.version === right.genai.version &&
    left.genai.sum === right.genai.sum
  );
}

export function encodeBoot(message: BootMessage): string {
  return JSON.stringify(message);
}

export function encodeHostMessage(message: HostMessage): string {
  return encodeJsonText(message);
}

/** Parses the page's boot message inside the Worker; anything else is refused. */
export function parseBoot(data: unknown): BootMessage {
  const value: unknown = typeof data === 'string' ? JSON.parse(data) : undefined;
  if (
    !isRecord(value) ||
    value['v'] !== 1 ||
    value['kind'] !== 'boot' ||
    Object.keys(value).length !== 3 ||
    !validWasmReference(value['wasm'])
  )
    throw new TypeError('The boot message is invalid.');
  return value as unknown as BootMessage;
}

/** Parses a page message inside the Worker after boot; anything else is refused. */
export function parseHostMessage(data: unknown): Exclude<HostMessage, BootMessage> | undefined {
  let value: unknown;
  try {
    value = typeof data === 'string' ? parseJsonText(data) : undefined;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value['v'] !== 1 || typeof value['runId'] !== 'string') return undefined;
  if (!IDENTIFIER.test(value['runId'])) return undefined;
  const keys = Object.keys(value).length;
  if (value['kind'] === 'run' && keys === 4 && boundedText(value['request']))
    return value as unknown as Exclude<HostMessage, BootMessage>;
  if (value['kind'] === 'cancel' && keys === 3)
    return value as unknown as Exclude<HostMessage, BootMessage>;
  if (
    value['kind'] === 'reply' &&
    typeof value['id'] === 'string' &&
    IDENTIFIER.test(value['id']) &&
    keys === 6 &&
    ((value['ok'] === true && boundedText(value['payload'])) ||
      (value['ok'] === false && typeof value['code'] === 'string'))
  )
    return value as unknown as Exclude<HostMessage, BootMessage>;
  return undefined;
}

export function encodeWorkerMessage(message: WorkerMessage): string {
  return encodeJsonText(message);
}

/** Parses a Worker message on the page; returns undefined for anything unexpected. */
export function parseWorkerMessage(data: unknown): WorkerMessage | undefined {
  let value: unknown;
  try {
    value = typeof data === 'string' ? parseJsonText(data) : undefined;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value['v'] !== 1) return undefined;
  const keys = Object.keys(value).length;
  if (
    value['kind'] === 'ready' &&
    (keys === 3 || (keys === 4 && validBuildInfo(value['build']))) &&
    typeof value['coldStartMs'] === 'number' &&
    Number.isFinite(value['coldStartMs'])
  )
    return value as unknown as WorkerMessage;
  if (
    value['kind'] === 'call' &&
    keys === 6 &&
    typeof value['runId'] === 'string' &&
    IDENTIFIER.test(value['runId']) &&
    typeof value['id'] === 'string' &&
    IDENTIFIER.test(value['id']) &&
    (value['op'] === 'model' || value['op'] === 'capability') &&
    boundedText(value['payload'])
  )
    return value as unknown as WorkerMessage;
  if (
    value['kind'] === 'done' &&
    keys === 4 &&
    typeof value['runId'] === 'string' &&
    IDENTIFIER.test(value['runId']) &&
    boundedText(value['result'])
  )
    return value as unknown as WorkerMessage;
  if (value['kind'] === 'failed' && Object.keys(value).length === 2)
    return value as unknown as WorkerMessage;
  if (
    value['kind'] === 'exit' &&
    Object.keys(value).length === 3 &&
    typeof value['code'] === 'number' &&
    Number.isSafeInteger(value['code'])
  )
    return value as unknown as WorkerMessage;
  return undefined;
}
