// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export interface WorkerReport {
  identity: { input: number[]; output: number[] } | undefined;
  tokenizer: { ids: number[]; rendered: string } | undefined;
  failures: Record<string, string>;
  violations: string[];
  functionConstructions: number;
  fetchCalls: number;
  requestedKeys: string[];
}

export interface PageData {
  done: boolean;
  report?: WorkerReport;
  pageViolations: string[];
  workerError?: string;
  trustedTypesPolicyCreated: boolean;
  workerUrlsChecked: number;
}
