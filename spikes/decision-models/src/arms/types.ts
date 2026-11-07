// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Answer, Question } from '../questions.js';
import type { Availability, FileVerification, Reason, RuntimeDump } from '../results.js';

export const ARM_IDS = ['mock', 'builtin-ai', 'watersheep', 'laya', 'd1'] as const;
export type ArmId = (typeof ARM_IDS)[number];
export type DedicatedId = 'watersheep' | 'laya' | 'd1';
export class ArmFailure extends Error {
  readonly reason: Reason;
  readonly files: FileVerification[];
  constructor(reason: Reason, files: FileVerification[] = []) {
    super(reason);
    this.reason = reason;
    this.files = files;
  }
}
export interface DecisionRequest {
  state: string;
  questions: Question[];
}
export interface DecisionReply {
  answers: Answer[];
  tokenizationMs: number;
  stateTokens: number;
  inputTokens: number;
  tokenSource: 'mock_approximation' | 'browser_measureInputUsage' | 'unavailable';
  generatedTokens: number | null;
  executedIn: string;
}
export interface LoadRecord {
  downloadMs: number | null;
  downloadReason: 'already_cached' | 'browser_managed' | 'mock_no_download' | null;
  loadMs: number;
  files: FileVerification[];
  runtime: RuntimeDump | null;
}
export interface Arm {
  readonly id: ArmId;
  probe(): Promise<Availability>;
  load(progress: (loaded: number, total: number | null) => void): Promise<LoadRecord>;
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionReply>;
  dispose(): Promise<void>;
}
