// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelDescriptor } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';

export function hostModels(mode: string): {
  readonly providers: Readonly<Record<string, ModelDescriptor>>;
  readonly chatModels: Readonly<Record<string, MockChatModel>>;
} {
  if (mode !== 'mock') return { providers: {}, chatModels: {} };
  return {
    providers: {
      mock: {
        destination: 'in-browser',
        modality: 'text',
        languages: ['en'],
        features: ['streaming', 'cancellation', 'tool-calling', 'structured-output'],
        pricing: { inputPerToken: 0, outputPerToken: 0 },
      },
    },
    chatModels: { mock: new MockChatModel({}) },
  };
}
