// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { type BaseTool, BaseToolset, LlmAgent, WebMCPToolset } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createAdkAdapter } from '../src/adapter.js';
import { FakeChatModel } from './support/fixtures.js';

test.each(['static', 'dynamic', 'nested', 'throwing', 'network'] as const)(
  '%s toolsets stay refused at prepare before expansion model or store access',
  async (kind) => {
    const provider = new FakeChatModel(() => new AIMessage({ content: 'unused' }));
    const store = { request: vi.fn(async () => null) };
    const expand = vi.fn();
    class AuthorToolset extends BaseToolset {
      readonly #members: readonly BaseTool[];

      constructor(members: readonly BaseTool[], dynamic = false) {
        super(dynamic ? () => true : []);
        this.#members = members;
      }

      override async getTools(): Promise<BaseTool[]> {
        expand();
        if (kind === 'throwing') throw new Error('The toolset must not be expanded.');
        return [...this.#members];
      }

      override async close(): Promise<void> {}
    }
    await expect(
      createAdkAdapter().prepare(
        (host) => {
          const tool = host.adk.capabilityTool('math.double@1', {
            description: 'Double.',
            parameters: z.object({ value: z.number() }),
          });
          const group = new AuthorToolset([tool], kind === 'dynamic');
          const tools =
            kind === 'network'
              ? [new WebMCPToolset()]
              : kind === 'nested'
                ? [new AuthorToolset([group as never])]
                : [group];
          return new LlmAgent({ name: 'root', model: host.adk.llm('answer'), tools });
        },
        { chatModels: { mock: provider }, checkpoints: store },
        {
          signal: new AbortController().signal,
          models: { roles: ['answer'], providers: { mock: { credential: false } } },
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(expand).not.toHaveBeenCalled();
    expect(provider.seen).toEqual([]);
    expect(store.request).not.toHaveBeenCalled();
  },
);
