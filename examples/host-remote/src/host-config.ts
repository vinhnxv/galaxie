// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { HttpCapabilityOptions, ModelRouting } from '@galaxie-ai/core';
import type { HostConfigHooks, ValidatedHostConfig } from '@galaxie-ai/core/config';
import { validateHostConfig } from '@galaxie-ai/core/config';
import { tutorDefinition } from '@galaxie-ai/example-english-tutor';
import document from '../galaxie.config.json' with { type: 'json' };

export { document };

export interface RemoteHostHooks {
  readonly headers: NonNullable<HttpCapabilityOptions['headers']>;
  readonly getCredential: NonNullable<ModelRouting['getCredential']>;
  readonly consent: NonNullable<ModelRouting['consent']>;
}

export function remoteHostHooks(hooks: RemoteHostHooks): HostConfigHooks {
  return {
    headers: { session: hooks.headers },
    getCredential: { 'model-proxy': hooks.getCredential },
    consent: { 'quiz-consent': hooks.consent },
  };
}

export function validateRemoteHost(
  baseURL: string,
  hooks: RemoteHostHooks,
  configuration: typeof document = document,
): ValidatedHostConfig<typeof tutorDefinition, 'lessons.get@1' | 'progress.save@1'> {
  return validateHostConfig(configuration, tutorDefinition, remoteHostHooks(hooks), baseURL);
}
