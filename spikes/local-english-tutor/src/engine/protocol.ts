// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Messages between the page and the inference worker. The worker owns the model; the page only
// sends chat turns and receives text.

/** A chat turn as the model's chat template expects it. */
export interface ChatTurn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * The part of JSON Schema that guided generation supports: what z.toJSONSchema writes for objects,
 * arrays, tuples, strings, enums and literals. The guide ignores other keywords.
 */
export interface JsonSchema {
  readonly type?: string;
  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly items?: JsonSchema | boolean;
  readonly prefixItems?: readonly JsonSchema[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly enum?: readonly string[];
  readonly const?: string;
}

export interface GenerateRequest {
  readonly messages: readonly ChatTurn[];
  readonly maxNewTokens: number;
  /** When set, the reply is one JSON value that matches this schema (json-guide.ts). */
  readonly jsonSchema?: JsonSchema;
}

export interface GenerationStats {
  readonly promptTokens: number;
  /** Every token of the reply, the ones a guided reply's structure took included. */
  readonly newTokens: number;
  /** In a guided reply, the tokens of the structure that the guide wrote rather than the model. */
  readonly forcedTokens?: number;
  /** Whether the model ended the reply. A guided reply ends where its JSON value ends. */
  readonly stoppedAtEos: boolean;
  readonly aborted: boolean;
  /** Time from the start of this request, after any queueing, to the first new token. */
  readonly timeToFirstTokenMs: number;
  readonly totalMs: number;
  readonly decodeTokensPerSecond: number | null;
}

export interface EngineInfo {
  readonly gpu: string;
  readonly shaderF16: boolean;
  readonly onnxruntimeWeb: string | undefined;
  readonly downloadedFiles: readonly string[];
  readonly filesReadyMs: number;
  readonly sessionCreateMs: number;
}

export interface LoadProgress {
  readonly stage: 'checking-gpu' | 'loading-files' | 'creating-session';
  readonly file?: string;
  readonly loadedBytes?: number;
  readonly totalBytes?: number;
}

export type ToWorker =
  | { readonly type: 'load' }
  | { readonly type: 'generate'; readonly id: number; readonly request: GenerateRequest }
  | { readonly type: 'abort'; readonly id: number };

export type FromWorker =
  | { readonly type: 'progress'; readonly progress: LoadProgress }
  | { readonly type: 'ready'; readonly info: EngineInfo }
  | { readonly type: 'load-failed'; readonly message: string }
  | { readonly type: 'text'; readonly id: number; readonly delta: string }
  | {
      readonly type: 'done';
      readonly id: number;
      readonly text: string;
      readonly stats: GenerationStats;
    }
  | { readonly type: 'failed'; readonly id: number; readonly message: string };
