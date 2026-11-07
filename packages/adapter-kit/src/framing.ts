// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/** The established UTF-8 frame or selected-field bound, as applied by each protocol. */
export const MAX_BRIDGE_BYTES: number = 1_048_576;

export function withinBridgeLimit(text: string): boolean {
  if (text.length > MAX_BRIDGE_BYTES) return false;
  if (text.length * 3 <= MAX_BRIDGE_BYTES) return true;
  return new TextEncoder().encode(text).byteLength <= MAX_BRIDGE_BYTES;
}

/** Parsing/serialization stay separate from protocol envelopes and error mapping. */
export function parseJsonText(text: string): unknown {
  return JSON.parse(text);
}

export function encodeJsonText(value: unknown): string {
  return JSON.stringify(value);
}

/** Validate outgoing values before serialization; callers own the error and size boundary. */
export function encodeValidatedJson(value: unknown, validate: (value: unknown) => void): string {
  validate(value);
  return encodeJsonText(value);
}
