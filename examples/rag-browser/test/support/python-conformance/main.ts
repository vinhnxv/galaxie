// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie/adapter-pyodide';
import { IndexedDBSaver } from '../../../../../packages/storage-indexeddb/src/index.js';
import {
  executePythonRestore,
  type PythonRestoreResult,
} from '../../../../../tests/conformance/support/python-restore.js';
import {
  executePythonCase,
  type PythonCaseTranscript,
  pythonStageACases,
} from '../../../../../tests/conformance/support/python-stage-a.js';
import {
  executePythonStream,
  type PythonScopeTrace,
  type PythonStreamResult,
  pythonStreamCases,
  pythonStreamProbes,
  recordPythonScopes,
} from '../../../../../tests/conformance/support/python-streaming.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: PythonCaseTranscript;
  restore?: PythonRestoreResult;
  stream?: PythonStreamResult;
  error?: string;
  violations: string[];
  done: boolean;
  scopes: PythonScopeTrace;
} = { violations: [], done: false, scopes: { capabilities: [], streams: [] } };
Object.assign(globalThis, { pythonConformance: result });
addEventListener('securitypolicyviolation', (event) =>
  result.violations.push(event.effectiveDirective),
);
const url = new URL(workerUrl, location.href).href;
const factory = Reflect.get(globalThis, 'trustedTypes') as {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
};
factory.createPolicy('default', {
  createScriptURL(value) {
    if (new URL(value, location.href).href !== url) throw new TypeError('Unexpected Worker URL.');
    return url;
  },
});

void (async () => {
  try {
    const query = new URLSearchParams(location.search);
    const name = query.get('case') ?? '';
    const streaming = [...pythonStreamCases, ...pythonStreamProbes, 'effect-scopes'].some(
      (item) => item === name,
    );
    if (
      !(pythonStageACases as readonly string[]).includes(name) &&
      name !== 'parent-effects' &&
      !streaming
    )
      throw new Error('The conformance case is unknown.');
    const module = (pythonStreamProbes as readonly string[]).includes(name)
      ? 'streaming'
      : name.replaceAll('-', '_');
    const files = [...new Set(['fixture_support', 'interrupt_resume', module])].map(
      (file) => `${file}.py`,
    );
    files.push('selected.py');
    const options: PyodideAdapterOptions = {
      runtimeUrl: new URL('/python/runtime/', location.href).href,
      wheelsUrl: new URL('/python/wheels/', location.href).href,
      localWheels: PYTHON_LOCAL_WHEELS,
      createWorker() {
        const worker = new Worker(url, { type: 'module' });
        worker.addEventListener('message', (event) => {
          const message = JSON.parse(event.data as string) as {
            type?: string;
            directive?: string;
          };
          if (message.type === 'violation') result.violations.push(message.directive ?? 'unknown');
          else if (name === 'effect-scopes') recordPythonScopes(event.data, result.scopes);
        });
        return worker;
      },
    };
    const agent = {
      baseUrl: new URL(`/conformance/${name}/`, location.href).href,
      module: 'selected',
      entry: 'create_agent',
      files,
    };
    if (streaming && !query.has('durable')) {
      result.stream = await executePythonStream(options, agent, name);
      return;
    }
    if (query.has('durable')) {
      const saver = await IndexedDBSaver.open({
        appId: 'python-restore',
        principalScope: 'fixture',
        databaseName: `python-restore-${name}`,
      });
      try {
        result.restore = await executePythonRestore(
          options,
          agent,
          { checkpoints: saver.byteRecords, recovery: saver.recovery },
          query.get('session') ?? undefined,
          query.has('accepted'),
          name === 'parent-effects',
          name === 'interrupt-subgraph' ? 'inner answer' : { answer: 'yes' },
        );
      } finally {
        saver.close();
      }
      return;
    }
    result.transcript = await executePythonCase(
      options,
      agent,
      name,
      { value: 1 },
      name === 'interrupt-sequence'
        ? [
            { action: 'submit', payload: 'first' },
            { action: 'submit', payload: false },
          ]
        : [{ action: 'submit', payload: { answer: 'yes' } }],
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Python conformance failed.';
  } finally {
    result.done = true;
  }
})();
