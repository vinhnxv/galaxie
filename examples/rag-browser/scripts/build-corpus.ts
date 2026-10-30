// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdir, writeFile } from 'node:fs/promises';

const { convertSquad, squadSource, verifySource } = (await import(
  new URL('../src/corpus.ts', import.meta.url).href
)) as typeof import('../src/corpus.js');

const response = await fetch(process.argv[2] ?? squadSource.url);
if (!response.ok) throw new Error('The corpus source download failed.');
const bytes = new Uint8Array(await response.arrayBuffer());
await verifySource(bytes);
const corpus = convertSquad(JSON.parse(new TextDecoder().decode(bytes)));
const directory = new URL('../public/data/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('squad-dev.json', directory), `${JSON.stringify(corpus, null, 2)}\n`);
console.info(`Wrote ${corpus.passages.length} passages and ${corpus.questions.length} questions.`);
