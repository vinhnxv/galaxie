// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expectTypeOf, test } from 'vitest';
import { z } from 'zod';
import {
  type BindingsFor,
  type CapabilityBinding,
  defineAgentDefinition,
  type InputOf,
} from '../src/index.js';

const tutor = defineAgentDefinition({
  id: 'galaxie.examples/english-tutor',
  version: '0.1.0',
  executor: 'langgraph-js',
  input: z.object({ lessonId: z.string() }),
  capabilities: {
    required: {
      'lessons.get@1': {
        input: z.object({ lessonId: z.string() }),
        output: z.object({ title: z.string() }),
        kind: 'read',
      },
    },
    optional: {
      'progress.save@1': {
        input: z.object({ score: z.number() }),
        output: z.object({ saved: z.boolean() }),
        kind: 'write',
      },
    },
  },
  models: {
    'quiz.generate': {
      modality: 'text',
      requires: ['structured-output'],
      languages: ['en', 'vi'],
      defaultPolicy: 'local-only',
    },
  },
  ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['lesson-main'] },
});

type TutorBindings = BindingsFor<typeof tutor>;
type LessonsGet = CapabilityBinding<{ lessonId: string }, { title: string }>;
type ProgressSave = CapabilityBinding<{ score: number }, { saved: boolean }>;

test('the run input type comes from the input schema', () => {
  expectTypeOf<InputOf<typeof tutor>>().toEqualTypeOf<{ lessonId: string }>();
});

test('a host binds every required capability and may bind optional ones', () => {
  expectTypeOf<{ 'lessons.get@1': LessonsGet }>().toExtend<TutorBindings>();
  expectTypeOf<{
    'lessons.get@1': LessonsGet;
    'progress.save@1': ProgressSave;
  }>().toExtend<TutorBindings>();
  expectTypeOf<{ 'progress.save@1': ProgressSave }>().not.toExtend<TutorBindings>();
});

test('a binding must match the capability schemas', () => {
  type NeedsMoreInput = CapabilityBinding<{ lessonId: string; level: string }, { title: string }>;
  type WrongOutput = CapabilityBinding<{ lessonId: string }, { title: number }>;
  expectTypeOf<{ 'lessons.get@1': NeedsMoreInput }>().not.toExtend<TutorBindings>();
  expectTypeOf<{ 'lessons.get@1': WrongOutput }>().not.toExtend<TutorBindings>();
});

test('a capability name must carry an @<version> suffix (ADR-0008)', () => {
  defineAgentDefinition({
    id: 'galaxie.examples/unversioned',
    version: '0.1.0',
    executor: 'langgraph-js',
    input: z.object({}),
    capabilities: {
      required: {
        // @ts-expect-error -- `lessons.get` has no `@<version>` suffix.
        'lessons.get': {
          input: z.object({ lessonId: z.string() }),
          output: z.object({ title: z.string() }),
          kind: 'read',
        },
      },
    },
  });
});
