// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export { ModelError, type ModelErrorCode, type ModelUnavailableReason } from '../errors.js';
export {
  type OpenAICompatibleCallOptions,
  OpenAICompatibleChatModel,
  type OpenAICompatibleOptions,
  openAICompatible,
} from './chat-model.js';
