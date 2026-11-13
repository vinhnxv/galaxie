// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import type { RunId, SessionId } from '@galaxie-ai/core';
import {
  BaseLlm,
  InMemoryRunner,
  isFinalResponse,
  LLMRegistry,
  LlmAgent,
  type LlmResponse,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test, vi } from 'vitest';
import { createAdkAdapter } from '../src/adapter.js';
import { defineAdkEntry } from '../src/interaction.js';
import { FakeChatModel, fakeModels, fakeTrace } from './support/fixtures.js';

test('native role strings use their scripted oracle while host admission never touches ADK registry or cache', async () => {
  const registry = Reflect.get(LLMRegistry, 'llmRegistryDict') as Map<unknown, unknown>;
  const cache = Reflect.get(Reflect.get(LLMRegistry, 'resolveCache'), 'cache') as Map<
    unknown,
    unknown
  >;
  const saved = new Map(registry);
  const savedCache = new Map(cache);
  let constructions = 0;
  class Scripted extends BaseLlm {
    static override supportedModels = [/^answer$/];
    constructor(options: { model: string }) {
      super(options);
      constructions += 1;
    }
    override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
      yield { content: { role: 'model', parts: [{ text: 'done' }] }, turnComplete: true };
    }
    override async connect(): Promise<never> {
      throw new Error('No live connection.');
    }
  }
  try {
    LLMRegistry.register(Scripted);
    const author = new LlmAgent({ name: 'root', model: 'answer' });
    expect(constructions).toBe(0);
    const native = new InMemoryRunner({ agent: author, appName: 'native' });
    const session = await native.sessionService.createSession({
      appName: 'native',
      userId: 'user',
    });
    const outputs = [];
    for await (const event of native.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'question' }] },
    })) {
      if (isFinalResponse(event))
        outputs.push(event.content?.parts?.map((part) => part.text ?? '').join(''));
    }
    expect(outputs).toEqual(['done']);
    expect(constructions).toBeGreaterThan(0);
    constructions = 0;
    const beforeRegistry = new Map(registry);
    const beforeCache = new Map(cache);
    const resolution = vi.spyOn(LLMRegistry, 'newLlm');
    const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
    const modelPort = fakeModels();
    const prepared = await createAdkAdapter().prepare(
      () => defineAdkEntry({ agent: author, roleStrings: true }),
      { chatModels: { mock: provider } },
      {
        signal: new AbortController().signal,
        models: { roles: ['answer'], providers: { mock: { credential: false } } },
      },
    );
    try {
      const actual = [];
      for await (const event of prepared.run({
        runId: 'run' as RunId,
        sessionId: 's' as SessionId,
        command: { type: 'start', input: { prompt: 'question' } },
        signal: new AbortController().signal,
        trace: fakeTrace().trace,
        models: modelPort.port,
        limits: { steps: 5 },
        capabilities: {
          async call(): Promise<never> {
            throw new Error('No capability expected.');
          },
        },
      })) {
        if (event.type === 'output') actual.push(event.output);
      }
      expect(actual).toEqual(outputs);
      expect(provider.seen).toHaveLength(1);
      expect(modelPort.leases[0]?.role).toBe('answer');
      expect(constructions).toBe(0);
      expect(resolution).not.toHaveBeenCalled();
      expect(registry).toEqual(beforeRegistry);
      expect(cache).toEqual(beforeCache);
    } finally {
      resolution.mockRestore();
      await prepared.dispose();
    }
  } finally {
    vi.restoreAllMocks();
    registry.clear();
    for (const [key, value] of saved) registry.set(key, value);
    cache.clear();
    for (const [key, value] of savedCache) cache.set(key, value);
  }
  expect(registry).toEqual(saved);
  expect(cache).toEqual(savedCache);
});
