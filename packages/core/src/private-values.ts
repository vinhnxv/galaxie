// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function registerPrivate(values: Iterable<string>, registered: Set<string>): void {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized.length >= 8) registered.add(normalized);
  }
}

export function containsPrivate(value: string, registered: ReadonlySet<string>): boolean {
  const candidate = normalize(value);
  for (const privateValue of registered)
    if (
      candidate.includes(privateValue) ||
      (candidate.length >= 8 && privateValue.includes(candidate))
    )
      return true;
  return false;
}
