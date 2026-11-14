// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export interface LaneAttribute {
  key: string;
  reason: string;
}

export interface LaneDifference {
  path: string;
  reason: string;
}

export const laneSpecificAttributes: readonly LaneAttribute[] = [];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function compareLanes(
  browser: unknown,
  node: unknown,
  allowedAttributes: readonly LaneAttribute[] = laneSpecificAttributes,
): LaneDifference[] {
  const ignored = new Set(allowedAttributes.map((attribute) => attribute.key));
  const differences: LaneDifference[] = [];
  const visit = (actual: unknown, expected: unknown, path: string, attributes = false): void => {
    if (Array.isArray(actual) && Array.isArray(expected)) {
      if (actual.length !== expected.length)
        differences.push({ path, reason: 'array length differs' });
      for (let index = 0; index < Math.min(actual.length, expected.length); index++)
        visit(actual[index], expected[index], `${path}[${index}]`);
    } else if (record(actual) && record(expected)) {
      for (const key of [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()) {
        if (attributes && ignored.has(key)) continue;
        const childPath = `${path}.${key}`;
        if (!Object.hasOwn(actual, key))
          differences.push({ path: childPath, reason: 'missing in browser' });
        else if (!Object.hasOwn(expected, key))
          differences.push({ path: childPath, reason: 'missing in Node' });
        else visit(actual[key], expected[key], childPath, key === 'attributes');
      }
    } else if (!Object.is(actual, expected)) differences.push({ path, reason: 'value differs' });
  };
  visit(browser, node, '$');
  return differences;
}
