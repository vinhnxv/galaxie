// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export { ModelError, type ModelErrorCode, type ModelUnavailableReason } from '../errors.js';
export {
  type OpenAICompatibleCallOptions,
  OpenAICompatibleChatModel,
  type OpenAICompatibleOptions,
  openAICompatible,
} from './chat-model.js';
