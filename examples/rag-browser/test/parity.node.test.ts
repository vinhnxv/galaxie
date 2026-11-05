// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { runtimeFiles } from '../../../packages/adapter-pyodide/src/runtime-files.js';
import { RetrievalIndex } from '../src/retrieval/index.js';
import { createMockEmbedder } from '../src/retrieval/mock-embedder.js';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from './support/python.node.js';
import { executePythonTranscript } from './support/python-parity/session.js';
import { assertTranscript, goldenTranscript, parityScript } from './support/transcript.js';

test('the scripted search results come from the fixture index and mock embedder', async () => {
  const embedder = createMockEmbedder();
  const index = new RetrievalIndex(embedder);
  try {
    await index.add(parityScript.corpus);
    for (const item of parityScript.session)
      expect(
        await index.search({ query: item.input.question, mode: item.input.mode, k: 10 }),
      ).toEqual(item.search);
  } finally {
    await embedder.dispose();
  }
});

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'Pyodide on Node replays the shared behavioral transcript'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture();
    try {
      const transcript = await executePythonTranscript(fixture.options, fixture.agent);
      assertTranscript(transcript, goldenTranscript);
      expect(fixture.workerErrors).toEqual([]);
      expect(fixture.counts.created).toBe(1);
      expect(fixture.counts.terminated).toBe(1);
      const coldStartMs = fixture.bootEvents.find((event) => event.phase === 'ready')?.coldStartMs;
      expect(typeof coldStartMs).toBe('number');
      await writeFile(
        '/tmp/galaxie-rag-python-node-metrics.json',
        JSON.stringify(
          {
            node: process.version,
            coldStartMs,
            responseBodyBytes: fixture.requests.reduce((sum, request) => sum + request.bytes, 0),
            runtimeFilesBytes: runtimeFiles.reduce((sum, file) => sum + file.bytes, 0),
            runtimeLoadedFromDisk: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  },
  60000,
);
