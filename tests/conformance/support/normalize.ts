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
  const interruptIds = new Set<string>();
  const addInterrupts = (input: JsonValue | undefined): void => {
    if (!Array.isArray(input)) return;
    for (const item of input) {
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof item['id'] === 'string'
      )
        interruptIds.add(item['id']);
    }
  };
  const collect = (input: JsonValue): void => {
    if (Array.isArray(input)) input.forEach(collect);
    else if (input !== null && typeof input === 'object') {
      addInterrupts(input['__interrupt__']);
      Object.values(input).forEach(collect);
    }
  };
  if (serialized !== null && typeof serialized === 'object' && !Array.isArray(serialized)) {
    if (serialized['events'] !== undefined) collect(serialized['events']);
    const pauses = serialized['pauses'];
    if (Array.isArray(pauses))
      for (const pause of pauses) {
        if (pause !== null && typeof pause === 'object' && !Array.isArray(pause))
          addInterrupts(pause['interrupts']);
      }
  }
  const interrupts = new Map<string, string>();
  const text = (input: string): string => {
    if (interruptIds.has(input)) {
      let replacement = interrupts.get(input);
      if (replacement === undefined) {
        replacement = `<interrupt:${interrupts.size + 1}>`;
        interrupts.set(input, replacement);
      }
      return replacement;
    }
    return input
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
  };
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
