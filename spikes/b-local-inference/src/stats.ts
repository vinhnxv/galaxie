// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export interface Spread {
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  p95Reason: 'no_runs' | 'fewer_than_20_runs' | null;
}
export function summarize(values: (number | null)[]): Spread {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const rank = (p: number): number | null => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return {
    min: sorted[0] ?? null,
    p50: rank(0.5),
    p95: sorted.length >= 20 ? rank(0.95) : null,
    max: sorted.at(-1) ?? null,
    p95Reason: sorted.length === 0 ? 'no_runs' : sorted.length < 20 ? 'fewer_than_20_runs' : null,
  };
}
export async function outputHash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
