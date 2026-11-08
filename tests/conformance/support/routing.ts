// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelRouting } from '@galaxie-ai/core';

export const assistantRoles: { readonly assistant: { readonly modality: 'text' } } = {
  assistant: { modality: 'text' },
};

/** Zero-priced local routing preserves native fixture behavior (ADR-0006). */
export function assistantRouting(): ModelRouting {
  return {
    providers: {
      assistant: {
        destination: 'in-browser',
        modality: 'text',
        features: ['streaming', 'cancellation'],
        pricing: { inputPerToken: 0, outputPerToken: 0 },
      },
    },
    roles: { assistant: { providers: ['assistant'], allow: ['in-browser'], maxTokens: 1000 } },
  };
}
