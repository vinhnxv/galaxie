// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export {
  encodeJsonText,
  encodeValidatedJson,
  MAX_BRIDGE_BYTES,
  parseJsonText,
  withinBridgeLimit,
} from './framing.js';
export { resolveProvider } from './providers.js';
export { storageMarkerCode } from './storage-markers.js';
export {
  type ArgumentChunk,
  argumentChunks,
  hasArgumentMirror,
  outputText,
  type ReplyCall,
  rawArgumentChunks,
  replyCalls,
  sameJson,
} from './tool-calls.js';
export {
  hasOnlyKeys,
  isJsonValue,
  isPlainObject,
  isRecord,
  type JsonValueChecks,
  nonemptyText,
  type ToolDefinitionChecks,
  validBridgeTool,
  validBridgeToolCall,
  validCapabilityRequest,
  validChatMessage,
  validModelOption,
} from './validation.js';
