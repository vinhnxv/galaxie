// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import {
  executePydanticCase,
  type PydanticTranscript,
  pydanticCases,
} from '../../../../../tests/conformance/support/pydantic-ai.js';
import {
  executePydanticReloadStep,
  type PydanticReloadResult,
  type PydanticReloadStep,
} from '../../../../../tests/conformance/support/pydantic-ai-restore.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: PydanticTranscript;
  reload?: PydanticReloadResult;
  error?: string;
  errorCode?: string;
  storageEmpty?: boolean;
  controlReadable?: boolean;
  checkpointReads?: number;
  exportPendingCount?: number;
  exportExecutor?: string;
  violations: string[];
  done: boolean;
} = { violations: [], done: false };
Object.assign(globalThis, { pydanticConformance: result });
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
    const parameters = new URLSearchParams(location.search);
    const name = parameters.get('case') ?? '';
    const reload = parameters.has('reload');
    if (
      !(pydanticCases as readonly string[]).includes(name) &&
      !(reload && ['approved-write', 'resumed-write'].includes(name))
    )
      throw new Error('The conformance case is unknown.');
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
        });
        return worker;
      },
    };
    const agent = {
      baseUrl: new URL(`/conformance/${name}/`, location.href).href,
      module: 'selected',
      entry: 'create_agent',
      files: [
        ['approved-write', 'resumed-write'].includes(name) ? 'reload_writes.py' : 'suite.py',
        'selected.py',
      ],
    };
    if (reload) {
      const saved = sessionStorage.getItem('pydanticReloadStep');
      const step: PydanticReloadStep & { fault?: string } = saved
        ? JSON.parse(saved)
        : {
            name,
            ...(parameters.has('accepted') ? { accepted: true } : {}),
            ...(parameters.has('fault') ? { fault: parameters.get('fault') ?? '' } : {}),
          };
      if (step.name !== name) throw new Error('The reload fixture does not match its page.');
      const saver = await IndexedDBSaver.open({
        databaseName: 'pydantic-conformance-reload',
        appId: 'pydantic-restore',
        principalScope: 'fixture',
      });
      let observedSession = step.sessionId;
      let controlBytes: Uint8Array | undefined;
      let faultApplied = false;
      let completionFailed = false;
      result.checkpointReads = 0;
      try {
        if (step.fault === 'executor' && step.sessionId) {
          await saver.recovery.recordSession(step.sessionId, {
            agentId: 'conformance/pydantic-restore',
            agentVersion: '1',
            executorId: 'langgraph-python',
          });
        }
        if (step.fault === 'corrupt' && step.sessionId) {
          const tuple = (await saver.byteRecords.request({
            op: 'get',
            executor: 'pydantic-ai-python',
            sessionId: step.sessionId,
            namespace: '',
          })) as {
            id: string;
            parentId: string | null;
            checkpoint: { type: string; bytes: Uint8Array };
            metadata: { type: string; bytes: Uint8Array };
          };
          controlBytes = tuple.checkpoint.bytes.slice();
          const record = {
            op: 'put',
            executor: 'pydantic-ai-python',
            namespace: '',
            id: tuple.id,
            parentId: tuple.parentId,
            checkpoint: tuple.checkpoint,
            metadata: tuple.metadata,
            timestamp: new Date().toISOString(),
          };
          await saver.byteRecords.request({ ...record, sessionId: 'untouched-session' });
          await saver.byteRecords.request({
            ...record,
            sessionId: step.sessionId,
            checkpoint: { type: tuple.checkpoint.type, bytes: new TextEncoder().encode('corrupt') },
          });
        }
        if (step.fault === 'orphan' && step.sessionId) {
          const saved = (await saver.byteRecords.request({
            op: 'get',
            executor: 'pydantic-ai-python',
            sessionId: step.sessionId,
            namespace: '',
          })) as { id: string };
          await saver.byteRecords.request({
            op: 'put-writes',
            executor: 'pydantic-ai-python',
            sessionId: step.sessionId,
            namespace: '',
            id: (BigInt(saved.id) + 1n).toString().padStart(20, '0'),
            taskId: 'conversation',
            taskPath: '',
            writes: [
              {
                channel: '__interrupt__',
                index: -3,
                interruptIds: ['orphan'],
                value: { type: 'json', bytes: new TextEncoder().encode('{"id":"orphan"}') },
              },
            ],
          });
        }
        result.reload = await executePydanticReloadStep(
          options,
          agent,
          {
            checkpoints: {
              async request(value) {
                const request = value as {
                  op: string;
                  sessionId: string;
                  parentId?: string | null;
                };
                if (['get', 'list'].includes(request.op))
                  result.checkpointReads = (result.checkpointReads ?? 0) + 1;
                if (
                  step.fault === 'completion' &&
                  !completionFailed &&
                  request.op === 'put' &&
                  request.parentId != null
                ) {
                  completionFailed = true;
                  throw new Error('Private host storage failure.');
                }
                if (
                  !faultApplied &&
                  request.op === 'put' &&
                  ['logout', 'takeover'].includes(step.fault ?? '')
                ) {
                  faultApplied = true;
                  observedSession = request.sessionId;
                  if (step.fault === 'logout') await saver.invalidatePrincipal();
                  else {
                    const next = await IndexedDBSaver.open({
                      databaseName: 'pydantic-conformance-reload',
                      appId: 'pydantic-restore',
                      principalScope: 'other',
                    });
                    try {
                      await next.fencing.claim();
                    } finally {
                      next.close();
                    }
                  }
                }
                return saver.byteRecords.request(value);
              },
            },
            recovery: saver.recovery,
          },
          step,
        );
        if (step.fault === 'orphan' || step.fault === 'completion') {
          const exported = await saver.exportSession(result.reload.sessionId, {
            personalContent: true,
          });
          result.exportPendingCount = exported.metadata.pendingInteractionCount;
          const executor = exported.checkpoints?.at(-1)?.executor;
          if (executor !== undefined) result.exportExecutor = executor;
        }
      } finally {
        if (faultApplied && observedSession) {
          const fresh = await IndexedDBSaver.open({
            databaseName: 'pydantic-conformance-reload',
            appId: 'pydantic-restore',
            principalScope: 'fixture',
          });
          try {
            const rows = await fresh.byteRecords.request({
              op: 'list',
              executor: 'pydantic-ai-python',
              sessionId: observedSession,
            });
            result.storageEmpty = Array.isArray(rows) && rows.length === 0;
          } finally {
            fresh.close();
          }
        }
        if (controlBytes) {
          const untouched = (await saver.byteRecords.request({
            op: 'get',
            executor: 'pydantic-ai-python',
            sessionId: 'untouched-session',
            namespace: '',
          })) as { checkpoint: { bytes: Uint8Array } };
          result.controlReadable =
            JSON.stringify([...untouched.checkpoint.bytes]) === JSON.stringify([...controlBytes]);
        }
        saver.close();
      }
    } else result.transcript = await executePydanticCase(options, agent, name);
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'pydantic-ai conformance failed.';
    if (typeof error === 'object' && error !== null && 'code' in error)
      result.errorCode = String(error.code);
  } finally {
    result.done = true;
  }
})();
