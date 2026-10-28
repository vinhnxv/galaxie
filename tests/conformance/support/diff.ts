// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/** A length mismatch owns its array path, while siblings still receive a full comparison. */
export function diff(expected: unknown, actual: unknown, path: string = '$'): string[] {
  if (Object.is(expected, actual)) return [];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return [path];
    return expected.flatMap((value, index) => diff(value, actual[index], `${path}[${index}]`));
  }
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => {
      const child = /^[A-Za-z_$][\w$]*$/.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return [child];
      return diff(left[key], right[key], child);
    });
  }
  return [path];
}
