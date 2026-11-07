// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// summarize adapted from spikes/b-local-inference/src/stats.ts; nearest-rank convention.
import type { Answer, Question } from './questions.js';

export interface Spread {
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
  p95Reason: 'no_runs' | 'fewer_than_20_runs' | null;
}
export function summarize(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number | null => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return {
    min: sorted[0] ?? null,
    p50: rank(0.5),
    p95: sorted.length >= 20 ? rank(0.95) : null,
    max: sorted.at(-1) ?? null,
    p95Reason: !sorted.length ? 'no_runs' : sorted.length < 20 ? 'fewer_than_20_runs' : null,
  };
}
export interface Accuracy {
  count: number;
  correct: number;
  fraction: number;
  wilson95: { low: number; high: number };
}
export function accuracy(correct: number, count: number): Accuracy {
  if (count <= 0 || correct < 0 || correct > count) throw new Error('invalid_counts');
  const z = 1.959963984540054;
  const fraction = correct / count;
  const denominator = 1 + (z * z) / count;
  const center = (fraction + (z * z) / (2 * count)) / denominator;
  const radius =
    (z * Math.sqrt((fraction * (1 - fraction)) / count + (z * z) / (4 * count * count))) /
    denominator;
  return {
    count,
    correct,
    fraction,
    wilson95: { low: Math.max(0, center - radius), high: Math.min(1, center + radius) },
  };
}
export interface Scored {
  question: Question;
  answer: Answer;
}
export function scoreAccuracy(rows: Scored[]): Accuracy {
  return accuracy(
    rows.filter(({ question, answer }) => question.label === answer.value).length,
    rows.length,
  );
}
export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number | null;
  accuracy: number | null;
  belowMinimum: boolean;
}
export type Calibration =
  | { status: 'not_applicable_no_confidence'; missingConfidence: number; total: number }
  | {
      status: 'measured';
      value: number;
      bins: CalibrationBin[];
      binCount: 10;
      minimumPerBin: 10;
      missingConfidence: number;
      total: number;
      counted: number;
    };
export function ece(rows: Scored[]): Calibration {
  const confident = rows.filter((row) => row.answer.confidence !== null);
  const missingConfidence = rows.length - confident.length;
  if (!confident.length)
    return { status: 'not_applicable_no_confidence', missingConfidence, total: rows.length };
  const bins: CalibrationBin[] = Array.from({ length: 10 }, (_, index) => {
    const selected = confident.filter(
      (row) => Math.min(9, Math.floor((row.answer.confidence ?? 0) * 10)) === index,
    );
    return {
      lower: index / 10,
      upper: (index + 1) / 10,
      count: selected.length,
      meanConfidence: selected.length
        ? selected.reduce((sum, row) => sum + (row.answer.confidence ?? 0), 0) / selected.length
        : null,
      accuracy: selected.length ? scoreAccuracy(selected).fraction : null,
      belowMinimum: selected.length < 10,
    };
  });
  return {
    status: 'measured',
    value: bins.reduce(
      (sum, bin) =>
        sum +
        (bin.count / confident.length) * Math.abs((bin.meanConfidence ?? 0) - (bin.accuracy ?? 0)),
      0,
    ),
    bins,
    binCount: 10,
    minimumPerBin: 10,
    missingConfidence,
    total: rows.length,
    counted: confident.length,
  };
}
