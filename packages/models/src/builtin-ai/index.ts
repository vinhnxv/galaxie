// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export { ModelError, type ModelErrorCode, type ModelUnavailableReason } from '../errors.js';
export {
  type BuiltInAIAvailability,
  type BuiltInAILanguages,
  type BuiltInAIProgress,
  checkBuiltInAI,
  type PrepareBuiltInAIOptions,
  prepareBuiltInAI,
} from './api.js';
export {
  type BuiltInAICallOptions,
  BuiltInAIChatModel,
  type BuiltInAIChatModelOptions,
} from './chat-model.js';
