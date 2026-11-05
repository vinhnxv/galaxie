// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import {
  type LockedWheel,
  lockedWheels,
  type PythonFramework,
  runtimeFiles,
} from '../../../packages/adapter-pyodide/src/runtime-files.js';
import { cspHeader } from '../src/host/csp.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const defaultCache = join(root, '.cache/python-wheels');
function workerHeaders(server: ViteDevServer | PreviewServer): void {
  server.middlewares.use((request, response, next) => {
    if (request.url?.includes('pyodide-worker')) {
      const setHeader = response.setHeader.bind(response);
      response.setHeader = (name, value) =>
        setHeader(
          name,
          name.toLowerCase() === 'content-security-policy' ? cspHeader('mock') : value,
        );
      response.setHeader('Content-Security-Policy', cspHeader('mock'));
    }
    next();
  });
}
export function pythonAssets(cacheDirectory: string = defaultCache): Plugin {
  const available = existsSync(join(cacheDirectory, 'local-wheels.json'));
  const local = available
    ? (
        JSON.parse(readFileSync(join(cacheDirectory, 'local-wheels.json'), 'utf8')) as {
          packages: LockedWheel[];
        }
      ).packages
    : [];
  const frameworks: readonly PythonFramework[] = ['langgraph', 'pydantic-ai', 'dspy', 'adk'];
  const assets: { file: string; bytes: Uint8Array; frameworks: readonly PythonFramework[] }[] = [];
  const add = (file: string, path: string, selected = frameworks): void => {
    assets.push({ file, bytes: readFileSync(path), frameworks: selected });
  };
  if (available) {
    for (const wheel of [...lockedWheels, ...local])
      add(`python/wheels/${wheel.file}`, join(cacheDirectory, wheel.file), wheel.frameworks);
    for (const file of runtimeFiles) {
      const path = join(root, 'packages/adapter-pyodide/node_modules/pyodide', file.file);
      const bytes = readFileSync(path);
      if (bytes.length !== file.bytes) throw new Error('The Python runtime inventory is invalid.');
      assets.push({ file: `python/runtime/${file.file}`, bytes, frameworks });
    }
    for (const file of ['__init__.py', 'graph.py', 'citations.py', 'prompt.py'])
      add(
        `python/agent/rag_agent/${file}`,
        join(root, 'examples/rag-browser/agent_py/rag_agent', file),
        file === 'graph.py' ? ['langgraph'] : frameworks,
      );
    for (const file of ['__init__.py', 'agent.py'])
      add(
        `python/agent/rag_pydantic_ai/${file}`,
        join(root, 'examples/rag-browser/agent_py/rag_pydantic_ai', file),
        ['pydantic-ai'],
      );
    for (const file of ['__init__.py', 'agent.py'])
      add(
        `python/agent/rag_dspy/${file}`,
        join(root, 'examples/rag-browser/agent_py/rag_dspy', file),
        ['dspy'],
      );
    add(
      'python/agent/rag_agent/prompt.json',
      join(root, 'examples/rag-browser/src/agent/prompt.json'),
    );
  }
  const bytes = Object.fromEntries(
    frameworks.map((framework) => [
      framework,
      assets
        .filter((asset) => asset.frameworks.includes(framework))
        .reduce((sum, asset) => sum + asset.bytes.length, 0),
    ]),
  );
  let included = available;
  return {
    name: 'rag-python-assets',
    config(_config, environment) {
      included = available && environment.command === 'build';
    },
    configureServer: workerHeaders,
    configurePreviewServer: workerHeaders,
    resolveId(id) {
      return id === 'virtual:rag-python' ? '\0rag-python' : undefined;
    },
    load(id) {
      return id === '\0rag-python'
        ? `export const pythonBuild = ${JSON.stringify({ available: included, bytes: included ? bytes : { langgraph: 0, 'pydantic-ai': 0, dspy: 0, adk: 0 }, localWheels: included ? local : [] })};`
        : undefined;
    },
    generateBundle() {
      for (const asset of assets)
        this.emitFile({ type: 'asset', fileName: asset.file, source: asset.bytes });
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const workers = Object.values(context.bundle ?? {}).filter((entry) =>
          entry.fileName.includes('pyodide-worker'),
        );
        const workerBytes = workers.reduce(
          (sum, entry) =>
            sum +
            (entry.type === 'chunk'
              ? Buffer.byteLength(entry.code)
              : typeof entry.source === 'string'
                ? Buffer.byteLength(entry.source)
                : entry.source.length),
          0,
        );
        return frameworks.map((framework) => ({
          tag: 'meta',
          attrs: {
            name: framework === 'langgraph' ? 'galaxie-python-bytes' : `galaxie-${framework}-bytes`,
            content: String(included ? (bytes[framework] ?? 0) + workerBytes : 0),
          },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}
