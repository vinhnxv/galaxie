// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Preserve the JSON representation before replacing generated identities in traversal order. */
export function normalize(value: unknown): JsonValue {
  const serialized: JsonValue = JSON.parse(JSON.stringify(value));
  const identities = new Map<string, string>();
  const text = (input: string): string =>
    input
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (uuid) => {
        const key = uuid.toLowerCase();
        let replacement = identities.get(key);
        if (replacement === undefined) {
          replacement = `<uuid:${identities.size + 1}>`;
          identities.set(key, replacement);
        }
        return replacement;
      })
      .replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
        '<timestamp>',
      );
  const visit = (input: JsonValue): JsonValue => {
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map(visit);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([key, child]) => [text(key), visit(child)]),
      );
    return input;
  };
  return visit(serialized);
}
