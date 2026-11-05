// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export const ARM_IDS = ['mock', 'ort-own-loop', 'webllm', 'transformers-js', 'prompt-api'] as const;
export type ArmId = (typeof ARM_IDS)[number];
export type UnavailableReason =
  | 'no_webgpu_adapter'
  | 'no_shader_f16'
  | 'api_missing'
  | 'api_unavailable'
  | 'language_unsupported'
  | 'not_implemented';
export interface Availability {
  status: 'available' | 'downloadable' | 'unavailable';
  reason?: UnavailableReason;
  raw?: string | null;
}
export interface ModelInfo {
  id: string;
  revision: string | null;
  dtype?: string;
}
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export type JsonSchema = Record<string, unknown>;
export interface LoadInfo {
  loadKind: 'cold' | 'warm' | 'unknown';
  reportedBytes: number | null;
  reason?: string;
}
export interface GenerationRequest {
  messages: Message[];
  schema?: JsonSchema;
  maxTokens: number;
  signal: AbortSignal;
  onChunk: (text: string) => void;
}
export interface GenerationResult {
  text: string;
  outputTokens?: number;
  forcedTokens?: number;
  modelChosenTokens?: number;
  constrained: boolean;
  executedIn: string;
  aborted: boolean;
}
export interface Session {
  generate(request: GenerationRequest): Promise<GenerationResult>;
  close(): Promise<void>;
}
export interface Arm {
  fallbacks?: string[];
  id: ArmId;
  model: ModelInfo;
  engineVersion: string;
  inWorker: boolean;
  decoding: 'greedy' | 'browser-default';
  schemaMechanism: string;
  sameCheckpointAs: ArmId | null;
  probe(): Promise<Availability>;
  load(onProgress: (loadedBytes: number, totalBytes?: number) => void): Promise<LoadInfo>;
  openSession(): Promise<Session>;
  dispose(): Promise<void>;
}
