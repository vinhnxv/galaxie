// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export { createAdkAdapter } from './adapter.js';
export type { AdkAgent, AdkHost, AdkServices, CapabilityToolSpec } from './host.js';
export { adkToolset } from './host.js';
export type {
  AdkDecision,
  AdkEntry,
  AdkEntryOptions,
  AdkPendingRequest,
} from './interaction.js';
export { defineAdkEntry } from './interaction.js';
export type { AdkChatModel } from './llm.js';
export { ensureAdkRuntimeEnv } from './runtime-shim.js';
export const ADK_EXECUTOR_ID: 'adk-js' = 'adk-js';
