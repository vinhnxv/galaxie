// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/** The largest module the adapter will fetch and compile. */
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

export type WorkerMessage =
  | { readonly v: 1; readonly kind: 'ready'; readonly coldStartMs: number }
  | { readonly v: 1; readonly kind: 'failed' }
  | { readonly v: 1; readonly kind: 'exit'; readonly code: number };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validWasmReference(value: unknown): value is GoWasmReference {
  return (
    object(value) &&
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

export function encodeBoot(message: BootMessage): string {
  return JSON.stringify(message);
}

/** Parses the page's boot message inside the Worker; anything else is refused. */
export function parseBoot(data: unknown): BootMessage {
  const value: unknown = typeof data === 'string' ? JSON.parse(data) : undefined;
  if (
    !object(value) ||
    value['v'] !== 1 ||
    value['kind'] !== 'boot' ||
    Object.keys(value).length !== 3 ||
    !validWasmReference(value['wasm'])
  )
    throw new TypeError('The boot message is invalid.');
  return value as unknown as BootMessage;
}

export function encodeWorkerMessage(message: WorkerMessage): string {
  return JSON.stringify(message);
}

/** Parses a Worker message on the page; returns undefined for anything unexpected. */
export function parseWorkerMessage(data: unknown): WorkerMessage | undefined {
  let value: unknown;
  try {
    value = typeof data === 'string' ? JSON.parse(data) : undefined;
  } catch {
    return undefined;
  }
  if (!object(value) || value['v'] !== 1) return undefined;
  if (
    value['kind'] === 'ready' &&
    Object.keys(value).length === 3 &&
    typeof value['coldStartMs'] === 'number' &&
    Number.isFinite(value['coldStartMs'])
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
