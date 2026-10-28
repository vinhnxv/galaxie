// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModelPreparation } from '@galaxie/core';
import { expect, test } from 'vitest';
import { MockChatModel } from '../../models/src/mock.js';
import { createLangGraphAdapter } from '../src/adapter.js';
import type { LangGraphServices } from '../src/host.js';

const model = new MockChatModel({});
const graph = () => ({
  stream: async () => (async function* (): AsyncGenerator<unknown> {})(),
  transform: async function* () {},
});
test.each([
  [false, {}],
  [true, { local: model }],
  [false, { local: () => model }],
] as const)(
  'prepare validates the routed provider credential flag %s',
  async (credential, chatModels) => {
    const models: ModelPreparation = { roles: ['assistant'], providers: { local: { credential } } };
    await expect(
      createLangGraphAdapter().prepare(graph, { chatModels } as LangGraphServices, {
        signal: new AbortController().signal,
        models,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  },
);
