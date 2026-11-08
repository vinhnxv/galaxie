// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createManifest } from '@galaxie-ai/core';
import { tutorDefinition } from '@galaxie-ai/example-english-tutor';
import { expect, test } from 'vitest';

test('generates the tutor manifest from its unchanged definition', () => {
  const { manifest, schemas } = createManifest(tutorDefinition, { entry: './dist/index.js' });
  expect(manifest).toEqual({
    schemaVersion: '0.2',
    id: 'galaxie.english-tutor',
    version: '0.0.0',
    executor: 'langgraph-js',
    entry: './dist/index.js',
    inputSchema: './schemas/input.json',
    requiredCapabilities: {
      'lessons.get@1': {
        kind: 'read',
        input: './schemas/lessons.get@1.input.json',
        output: './schemas/lessons.get@1.output.json',
      },
      'progress.save@1': {
        kind: 'write',
        input: './schemas/progress.save@1.input.json',
        output: './schemas/progress.save@1.output.json',
      },
    },
    models: {
      'quiz.generate': { modality: 'text', requires: ['structured-output'], languages: ['en'] },
      'tutor.feedback': {
        modality: 'text',
        requires: ['structured-output'],
        languages: ['en'],
        defaultPolicy: 'local-only',
      },
    },
    ui: {
      catalog: 'education/v1',
      components: ['Quiz', 'WritingPrompt', 'Feedback', 'Progress'],
      surfaces: ['lesson-main'],
    },
  });
  expect(Object.keys(schemas)).toEqual([
    './schemas/input.json',
    './schemas/lessons.get@1.input.json',
    './schemas/lessons.get@1.output.json',
    './schemas/progress.save@1.input.json',
    './schemas/progress.save@1.output.json',
  ]);
  expect(schemas['./schemas/lessons.get@1.output.json']).toMatchObject({
    'x-galaxie': { label: 'public' },
  });
});
