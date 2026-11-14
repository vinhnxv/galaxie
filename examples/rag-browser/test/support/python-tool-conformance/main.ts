// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />
import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '../../../../../packages/storage-indexeddb/src/index.js';
import {
  executeToolReload,
  type ToolReloadResult,
} from '../../../../../tests/conformance/support/python-tool-restore.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const report: { done: boolean; violations: string[]; error?: string; reload?: ToolReloadResult } = {
  done: false,
  violations: [],
};
Reflect.set(globalThis, 'pythonToolConformance', report);
addEventListener('securitypolicyviolation', (event) =>
  report.violations.push(event.effectiveDirective),
);
const url = new URL(workerUrl, location.href).href;
const factory = Reflect.get(globalThis, 'trustedTypes') as
  | { createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown }
  | undefined;
factory?.createPolicy('default', {
  createScriptURL(value) {
    if (new URL(value, location.href).href !== url) throw new TypeError('Unexpected Worker URL.');
    return url;
  },
});
void (async () => {
  const saver = await IndexedDBSaver.open({
    databaseName: 'python-tool-reload',
    appId: 'python-tool-reload',
    principalScope: 'fixture',
  });
  try {
    const saved = sessionStorage.getItem('pythonToolSession');
    const replay = new URLSearchParams(location.search).get('replay') === 'true';
    report.reload = await executeToolReload(
      {
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
            if (message.type === 'violation')
              report.violations.push(message.directive ?? 'unknown');
          });
          return worker;
        },
      },
      {
        baseUrl: new URL('/conformance/tool-loop/', location.href).href,
        files: ['tool_loop.py'],
        module: 'tool_loop',
        entry: 'create_agent',
      },
      { checkpoints: saver.byteRecords, recovery: saver.recovery },
      replay,
      saved ?? undefined,
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    saver.close();
    report.done = true;
  }
})();
