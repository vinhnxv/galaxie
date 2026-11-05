// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
