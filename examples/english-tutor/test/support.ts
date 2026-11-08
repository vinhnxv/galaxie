// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentInstance,
  createRuntime,
  type DiagnosticEvent,
  galaxieField,
  type RunEvent,
  type UiBindings,
} from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import { expect } from 'vitest';
import { z } from 'zod';
import { createSpanRecorder } from '../../../packages/core/test/span-tree.js';
import {
  createTutorAgent,
  lessonFixture,
  type ProgressInput,
  type QuizDraft,
  type TutorInput,
  tutorDefinition,
} from '../src/index.js';

export const draft: QuizDraft = {
  questions: [
    {
      prompt: 'She ___ to school every day.',
      options: [
        { id: 'walk', label: 'walk' },
        { id: 'walks', label: 'walks' },
        { id: 'walking', label: 'walking' },
      ],
      correctOptionId: 'walks',
    },
    {
      prompt: 'They ___ football on Sundays.',
      options: [
        { id: 'play', label: 'play' },
        { id: 'plays', label: 'plays' },
        { id: 'playing', label: 'playing' },
      ],
      correctOptionId: 'play',
    },
    {
      prompt: 'He ___ coffee in the morning.',
      options: [
        { id: 'drink', label: 'drink' },
        { id: 'drinking', label: 'drinking' },
        { id: 'drinks', label: 'drinks' },
      ],
      correctOptionId: 'drinks',
    },
  ],
};
export const sentence = 'learner-sentence-canary-5827: I walk to school every day.';

const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .max(64);
const continueAction = { continue: { payload: z.strictObject({}) } };
export const ui: UiBindings = {
  surfaces: ['lesson-main'],
  components: {
    'education.Quiz/v1': {
      actions: {
        submit: {
          payload: z.strictObject({
            answers: z
              .record(id, id)
              .refine(
                (answers) => Object.keys(answers).length >= 1 && Object.keys(answers).length <= 20,
              ),
          }),
        },
      },
    },
    'education.WritingPrompt/v1': {
      actions: {
        submit: {
          payload: z.strictObject({
            sentence: z
              .string()
              .trim()
              .min(1)
              .max(500)
              .meta(galaxieField({ label: 'private-user', shape: 'freeText' })),
          }),
        },
      },
    },
    'education.Feedback/v1': { actions: continueAction },
    'education.Progress/v1': { actions: continueAction },
  },
};

export interface TutorFixture {
  instance: AgentInstance<TutorInput, unknown>;
  events: RunEvent[];
  diagnostics: DiagnosticEvent[];
  saves: ProgressInput[];
  quizModel: MockChatModel;
  reviewModel: MockChatModel;
  advance(payload: unknown, action?: string): Promise<void>;
  spans(): string;
  dispose(): Promise<void>;
}

export async function tutorFixture(
  options: { ui?: UiBindings; draft?: QuizDraft; remoteReview?: boolean; reviewError?: Error } = {},
): Promise<TutorFixture> {
  const { exporter, provider } = createSpanRecorder();
  const diagnostics: DiagnosticEvent[] = [];
  const saves: ProgressInput[] = [];
  const events: RunEvent[] = [];
  const quizModel = new MockChatModel({
    [JSON.stringify({ content: lessonFixture.content, grammarPoint: lessonFixture.grammarPoint })]:
      { id: 'quiz-draft', text: JSON.stringify(options.draft ?? draft) },
  });
  const reviewModel = new MockChatModel({
    [JSON.stringify({
      rubric: lessonFixture.rubric,
      grammarPoint: lessonFixture.grammarPoint,
      sentence,
    })]:
      options.reviewError === undefined
        ? {
            id: 'writing-review',
            text: JSON.stringify({
              verdict: 'correct',
              comments: ['Your subject and verb agree.'],
            }),
          }
        : { error: options.reviewError },
  });
  const runtime = createRuntime({
    appId: 'english-tutor-tests',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
  });
  try {
    const destination = options.remoteReview ? 'host-server' : 'in-browser';
    const descriptor = {
      modality: 'text' as const,
      features: ['structured-output'] as const,
      languages: ['en'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    };
    const binding = {
      destination: 'in-browser' as const,
      timeoutMs: 1000,
      concurrency: 1,
      grantScope: 'instance' as const,
      approval: 'none' as const,
      retry: 'none' as const,
    };
    const instance = await runtime.create(tutorDefinition, {
      principalScope: 'test-learner',
      agent: createTutorAgent(),
      ui: options.ui ?? ui,
      services: { chatModels: { quiz: quizModel, review: reviewModel } },
      models: {
        providers: {
          quiz: { ...descriptor, destination: 'in-browser' },
          review: { ...descriptor, destination },
        },
        roles: {
          'quiz.generate': { providers: ['quiz'], allow: ['in-browser'], maxTokens: 2000 },
          'tutor.feedback': { providers: ['review'], allow: [destination], maxTokens: 1000 },
        },
      },
      bindings: {
        'lessons.get@1': { ...binding, kind: 'read', invoke: async () => lessonFixture },
        'progress.save@1': {
          ...binding,
          kind: 'write',
          invoke: async (input) => {
            saves.push(input);
            return { saved: true };
          },
        },
      },
    });
    await instance.prepare();
    const { runId } = await instance.start({ lessonId: lessonFixture.id });
    const journal = (async (): Promise<void> => {
      for await (const event of instance.events(runId)) events.push(event);
    })();
    const settle = async (): Promise<void> => {
      await expect
        .poll(() => instance.getSnapshot().run?.status)
        .toSatisfy((status: string) => ['waiting_input', 'failed', 'succeeded'].includes(status));
    };
    await settle();
    return {
      instance,
      events,
      diagnostics,
      saves,
      quizModel,
      reviewModel,
      async advance(payload, action = 'submit') {
        const pending = instance.getSnapshot().run?.pending;
        if (pending === undefined) throw new Error('The tutor is not waiting for input.');
        expect(
          await instance.dispatch({
            ...pending,
            instanceId: instance.instanceId,
            runId,
            action,
            payload,
          }),
        ).toMatchObject({ status: 'accepted' });
        await settle();
      },
      spans: () =>
        JSON.stringify(
          exporter
            .getFinishedSpans()
            .map(({ attributes, events, status }) => ({ attributes, events, status })),
        ),
      async dispose() {
        await runtime.dispose();
        await journal;
        await provider.shutdown();
      },
    };
  } catch (error) {
    await runtime.dispose();
    await provider.shutdown();
    throw error;
  }
}
