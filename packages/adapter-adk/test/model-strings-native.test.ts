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
import { FakeChatModel, fakeModels, fakeTrace } from './support/fixtures.js';

// NM1 passes: lazy resolution, inheritance and reassignment. This isolated file
// owns its decoy registration and restores both registry and resolution cache.
// GM2 passes for the test-local single-root mapping; AL-M matches native text.
test('native strings resolve lazily and a routed replacement never resolves the decoy', async () => {
  const registry = Reflect.get(LLMRegistry, 'llmRegistryDict') as Map<unknown, unknown>;
  const cache = Reflect.get(Reflect.get(LLMRegistry, 'resolveCache'), 'cache') as Map<
    unknown,
    unknown
  >;
  const saved = new Map(registry);
  const savedCache = new Map(cache);
  let constructions = 0;
  class Scripted extends BaseLlm {
    static override supportedModels = [/^spike_answer$/];
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
    const child = new LlmAgent({ name: 'child' });
    const root = new LlmAgent({ name: 'root', model: 'spike_answer', subAgents: [child] });
    expect(constructions).toBe(0);
    expect(child.canonicalModel).toBeInstanceOf(Scripted);
    const runner = new InMemoryRunner({ agent: root, appName: 'spike' });
    const session = await runner.sessionService.createSession({ appName: 'spike', userId: 'user' });
    const native = [];
    for await (const event of runner.runAsync({
      userId: 'user',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: 'question' }] },
    })) {
      if (isFinalResponse(event))
        native.push(
          event.content?.parts
            ?.filter((part) => !part.thought)
            .map((part) => part.text ?? '')
            .join(''),
        );
    }
    expect(native).toEqual(['done']);
    const replacement = new Scripted({ model: 'replacement' });
    root.model = replacement;
    expect(root.canonicalModel).toBe(replacement);
    expect(child.canonicalModel).toBe(replacement);
    root.model = 'spike_unregistered';
    expect(() => root.canonicalModel).toThrow('not found');

    constructions = 0;
    const before = [...registry];
    const spy = vi.spyOn(LLMRegistry, 'newLlm');
    const provider = new FakeChatModel(() => new AIMessage({ content: 'done' }));
    const models = fakeModels();
    const prepared = await createAdkAdapter().prepare(
      (host) => {
        const mapped = new LlmAgent({ name: 'root', model: 'spike_answer' });
        mapped.model = host.adk.llm('spike_answer');
        return mapped;
      },
      { chatModels: { mock: provider } },
      {
        signal: new AbortController().signal,
        models: { roles: ['spike_answer'], providers: { mock: { credential: false } } },
      },
    );
    try {
      const output = [];
      for await (const event of prepared.run({
        runId: 'run' as RunId,
        sessionId: 's' as SessionId,
        command: { type: 'start', input: { prompt: 'question' } },
        signal: new AbortController().signal,
        trace: fakeTrace().trace,
        models: models.port,
        limits: { steps: 5 },
        capabilities: {
          async call(): Promise<never> {
            throw new Error('No capability expected.');
          },
        },
      })) {
        if (event.type === 'output') output.push(event.output);
      }
      expect(output).toEqual(native);
      expect(spy).not.toHaveBeenCalled();
      expect(constructions).toBe(0);
      expect([...registry]).toEqual(before);
      expect(provider.seen).toHaveLength(1);
      expect(models.leases[0]?.role).toBe('spike_answer');
    } finally {
      spy.mockRestore();
      await prepared.dispose();
    }
  } finally {
    vi.restoreAllMocks();
    registry.clear();
    for (const [key, value] of saved) registry.set(key, value);
    cache.clear();
    for (const [key, value] of savedCache) cache.set(key, value);
  }
  expect([...registry]).toEqual([...saved]);
  expect([...cache]).toEqual([...savedCache]);
});
