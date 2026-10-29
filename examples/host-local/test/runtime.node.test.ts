// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { AgentInstance, CapabilityContext, OutputSafetyCheck } from '@galaxie/core';
import { lessonFixture, type TutorInput } from '@galaxie/example-english-tutor';
import type { WebLLMEngineHandle } from '@galaxie/models/webllm';
import { describe, expect, it, vi } from 'vitest';
import { recordNetwork } from '../../../packages/core/test/network-recorder.js';
import {
  FakeLanguageModel,
  installLanguageModel,
} from '../../../packages/models/test/support/fake-language-model.js';
import { createMockModels, quizReply, reviewReply, sentinelSentence } from '../src/mock-script.js';
import { createLocalHost, hostLearnerId, outputSafety, realModels } from '../src/runtime.js';

async function completeLesson(instance: AgentInstance<TutorInput, unknown>): Promise<void> {
  await instance.prepare();
  const { runId } = await instance.start({ lessonId: lessonFixture.id });
  for (const [component, action, payload] of [
    ['education.Quiz/v1', 'submit', { answers: { q1: 'a', q2: 'a', q3: 'c' } }],
    ['education.WritingPrompt/v1', 'submit', { sentence: sentinelSentence }],
    ['education.Feedback/v1', 'continue', {}],
    ['education.Progress/v1', 'continue', {}],
  ] as const) {
    await expect.poll(() => instance.getSnapshot().run?.pending?.component).toBe(component);
    const pending = instance.getSnapshot().run?.pending;
    if (!pending) throw new Error('Expected a pending interaction.');
    expect(
      await instance.dispatch({
        ...pending,
        instanceId: instance.instanceId,
        runId,
        action,
        payload,
      }),
    ).toMatchObject({ status: 'accepted' });
  }
  await expect.poll(() => instance.getSnapshot().run?.status).toBe('succeeded');
  let output: unknown;
  for await (const event of instance.events(runId)) {
    if (event.type === 'output') output = event.output;
  }
  expect(output).toEqual({
    lessonId: lessonFixture.id,
    score: 2,
    total: 3,
    saved: true,
  });
}

describe('local host runtime', () => {
  it('runs the mock tutor and saves only the projected progress under the host learner', async () => {
    const host = createLocalHost(createMockModels());
    try {
      await completeLesson(await host.createInstance());
      expect([...host.progress]).toEqual([
        [hostLearnerId, { lessonId: lessonFixture.id, score: 2, total: 3 }],
      ]);
      const context = {} as CapabilityContext;
      await expect(
        host.bindings['lessons.get@1'].invoke({ lessonId: 'other' }, context),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        host.bindings['progress.save@1'].invoke({ lessonId: 'other', score: 1, total: 3 }, context),
      ).rejects.toMatchObject({ code: 'denied' });
      expect(host.progress.size).toBe(1);
    } finally {
      await host.runtime.dispose();
    }
  });

  it('demonstrates the output safety seam', () => {
    const check = { text: 'A normal reply.' } as OutputSafetyCheck;
    expect(outputSafety(check)).toBe('allow');
    expect(outputSafety({ ...check, text: 'Reply GALAXIE_BLOCK_DEMO end' })).toBe('block');
  });

  it('routes both roles to fake Built-in AI without loading WebLLM or starting a worker', async () => {
    let reply = 0;
    const pieces: string[] = [];
    const fake = new FakeLanguageModel({
      pieces,
      prompt: () => {
        pieces[0] = JSON.stringify(reply++ === 0 ? quizReply : reviewReply);
      },
    });
    const restore = installLanguageModel(fake);
    const network = recordNetwork();
    const unusedHandle = {
      stream: vi.fn(() => {
        throw new Error('WebLLM must stay unused.');
      }),
    } as unknown as WebLLMEngineHandle;
    const host = createLocalHost(realModels(unusedHandle));
    try {
      await network.selfTest();
      const instance = await host.createInstance();
      await completeLesson(instance);
      expect(instance.getSnapshot().routes).toMatchObject({
        'quiz.generate': { providerId: 'builtin', destination: 'in-browser' },
        'tutor.feedback': { providerId: 'builtin', destination: 'in-browser' },
      });
      expect(reply).toBe(2);
      expect(unusedHandle.stream).not.toHaveBeenCalled();
      expect(network.calls).toEqual([]);
    } finally {
      await host.runtime.dispose();
      network.restore();
      restore();
    }
  });
});
