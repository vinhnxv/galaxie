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

function percentDecode(value: string): string {
  const spaced = value.replaceAll('+', ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

export function containsPrivateEncoded(value: string, registered: ReadonlySet<string>): boolean {
  const decoded = percentDecode(value);
  return [value, decoded, percentDecode(decoded)].some((form) => containsPrivate(form, registered));
}
