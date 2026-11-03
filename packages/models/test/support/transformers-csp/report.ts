// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export interface WorkerReport {
  identity: { input: number[]; output: number[] } | undefined;
  tokenizer: { ids: number[]; rendered: string } | undefined;
  /** The reply a schema-constrained greedy decode produced when the logits favored `z`. */
  constrained: string | undefined;
  failures: Record<string, string>;
  violations: string[];
  functionConstructions: number;
  fetchCalls: number;
  requestedKeys: string[];
}

export function emptyReport(): WorkerReport {
  return {
    identity: undefined,
    tokenizer: undefined,
    constrained: undefined,
    failures: {},
    violations: [],
    functionConstructions: 0,
    fetchCalls: 0,
    requestedKeys: [],
  };
}

export interface PageData {
  done: boolean;
  report?: WorkerReport;
  pageViolations: string[];
  workerError?: string;
  trustedTypesPolicyCreated: boolean;
  workerUrlsChecked: number;
}
