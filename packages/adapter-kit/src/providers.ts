// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError, type ModelCall, toErrorInfo } from '@galaxie-ai/core';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/** Resolve an already selected lease. Credentials enter only the call-scoped factory. */
export function resolveProvider(
  providers: Readonly<
    Record<string, BaseChatModel | ((options: { readonly credential: string }) => BaseChatModel)>
  >,
  lease: Pick<ModelCall, 'providerId' | 'credential'>,
): BaseChatModel {
  const implementation = Object.hasOwn(providers, lease.providerId)
    ? providers[lease.providerId]
    : undefined;
  if (implementation === undefined)
    throw new GalaxieError('unavailable', toErrorInfo('unavailable').message);
  if (typeof implementation === 'function' && lease.credential === undefined)
    throw new GalaxieError('invalid', toErrorInfo('invalid').message);
  return typeof implementation === 'function'
    ? implementation({ credential: lease.credential as string })
    : implementation;
}
