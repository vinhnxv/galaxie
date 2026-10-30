// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { exercise } from './host.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const runtimeFiles = await Promise.all(
  [
    'pyodide.mjs',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
  ].map(async (file) => {
    const bytes = await readFile(`${root}node_modules/pyodide/${file}`);
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }),
);
const server = await createServer({
  root,
  optimizeDeps: { exclude: ['pyodide'] },
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
await mkdir(`${root}.cache/packages-${process.pid}`, { recursive: true });
let browser;
try {
  const node = await exercise(
    new Worker(new URL('./worker.mjs', import.meta.url)),
    origin,
    `${root}.cache/packages-${process.pid}`,
  );
  console.log('Node paths passed', node.coldStartMs);
  await writeFile(`${root}node-result.json`, JSON.stringify(node, null, 2));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (message) => console.log('Chromium:', message.text()));
  page.on('pageerror', (error) => console.error(error));
  await page.goto(origin);
  const chromiumResult = await page.evaluate(() => globalThis.result);
  await writeFile(
    `${root}chromium-result.json`,
    JSON.stringify({ version: browser.version(), ...chromiumResult }, null, 2),
  );
  console.log('Chromium paths passed', chromiumResult.coldStartMs);
  const metrics = (result) => ({
    runtimeMs: result.boot.runtimeMs,
    coldStartMs: result.coldStartMs,
    abortMs: result.abortMs,
    forcedTerminationMs: result.forcedTerminationMs,
    fetchedResponseBodyBytes: result.boot.downloads.reduce((sum, row) => sum + row.bytes, 0),
    fetchedWheelBodyBytes: result.boot.downloads
      .filter((row) => new URL(row.url).pathname.endsWith('.whl'))
      .reduce((sum, row) => sum + row.bytes, 0),
    uniqueWheelBodyBytes: Array.from(
      new Map(
        result.boot.downloads
          .filter((row) => new URL(row.url).pathname.endsWith('.whl'))
          .map((row) => [row.sha256, row.bytes]),
      ).values(),
    ).reduce((sum, bytes) => sum + bytes, 0),
    requests: result.boot.downloads.length,
  });
  const versions = (result) => JSON.stringify(Object.entries(result.boot.versions).sort());
  if (versions(node) !== versions(chromiumResult))
    throw Error('Python dependency versions differ between hosts.');
  await writeFile(
    `${root}summary.json`,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        environment: {
          node: process.version,
          chromium: browser.version(),
          platform: os.platform(),
          architecture: os.arch(),
          cpu: os.cpus()[0].model,
        },
        pyodide: '314.0.7',
        runtimeFiles,
        runtimeFileBytes: runtimeFiles.reduce((sum, row) => sum + row.bytes, 0),
        node: metrics(node),
        chromium: metrics(chromiumResult),
        versionsMatch: true,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
