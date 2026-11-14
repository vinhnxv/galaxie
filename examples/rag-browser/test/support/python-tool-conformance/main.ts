// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />
import '../../../src/host/zod-config.js';
import { createPyodideAdapter, type PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import {
  createRuntime,
  defineAgentDefinition,
  type PendingInteraction,
  type SessionId,
} from '@galaxie-ai/core';
import { z } from 'zod';
import { MockChatModel } from '../../../../../packages/models/src/mock.js';
import { parseByteRequest } from '../../../../../packages/storage-indexeddb/src/byte-records.js';
import { IndexedDBSaver } from '../../../../../packages/storage-indexeddb/src/index.js';
import { confirmationsFor } from '../../../../../tests/conformance/support/auto-confirm.js';
import {
  executeToolReload,
  type ToolReloadResult,
} from '../../../../../tests/conformance/support/python-tool-restore.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const report: {
  done: boolean;
  violations: string[];
  error?: string;
  reload?: ToolReloadResult;
  candidate?: CandidateResult;
} = {
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
          if (message.type === 'violation') report.violations.push(message.directive ?? 'unknown');
        });
        return worker;
      },
    };
    const probe = new URLSearchParams(location.search).get('probe');
    if (probe) report.candidate = await executeCandidate(options, saver, probe);
    else
      report.reload = await executeToolReload(
        options,
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

interface CandidateResult {
  sessionId: string;
  effects: string[];
  calls: unknown[];
  scopes: string[];
  receipts: unknown[];
  pending?: PendingInteraction;
  restored?: PendingInteraction;
  final?: unknown;
  crashReady?: boolean;
  restoreMissing?: boolean;
  startCode?: string;
}

async function executeCandidate(
  options: PyodideAdapterOptions,
  saver: IndexedDBSaver,
  probe: string,
): Promise<CandidateResult> {
  if (!['reads', 'writes', 'crash'].includes(probe)) throw new Error('Unknown candidate probe.');
  const saved = sessionStorage.getItem('pythonToolCandidateStep');
  const step: CandidateResult | undefined = saved ? JSON.parse(saved) : undefined;
  const calls: unknown[] = [],
    effects: string[] = [],
    scopes: string[] = [];
  const held = Promise.withResolvers<void>();
  const intercepted = Promise.withResolvers<void>();
  const model = new MockChatModel({
    parallel: [
      {
        id: 'calls',
        text: '',
        toolCalls: [
          { id: 'call-1', name: 'read', args: { value: 2 } },
          { id: 'call-2', name: 'read', args: { value: 4 } },
        ],
      },
      { id: 'final', text: 'done' },
    ],
    'two-writes': [
      {
        id: 'calls',
        text: '',
        toolCalls: [
          { id: 'call-1', name: 'write', args: { value: 2 } },
          { id: 'call-2', name: 'write', args: { value: 4 } },
        ],
      },
      { id: 'final', text: 'done' },
    ],
    write: [
      { id: 'calls', text: '', toolCalls: [{ id: 'call-1', name: 'write', args: { value: 4 } }] },
      { id: 'final', text: 'done' },
    ],
  });
  const runtime = createRuntime({
    appId: 'python-tool-reload',
    executors: [
      createPyodideAdapter({
        ...options,
        createWorker() {
          const worker = options.createWorker();
          worker.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data));
            if (message.kind === 'request' && message.op === 'capability')
              scopes.push(message.payload.effectScope);
          });
          return worker;
        },
      }),
    ],
    outputSafety: () => 'allow',
  });
  const input = z.object({ value: z.number().int() });
  const binding = {
    destination: 'in-browser' as const,
    timeoutMs: 1000,
    concurrency: 2,
    grantScope: 'instance' as const,
    retry: 'none' as const,
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/python-tool-candidate',
      version: '1',
      executor: 'langgraph-python',
      input: z.unknown(),
      models: { answer: { modality: 'text', defaultPolicy: 'remote-allowed' } },
      capabilities: {
        required: {
          'read@1': { kind: 'read', input, output: z.string() },
          'write@1': { kind: 'write', input, output: z.string() },
        },
      },
    }),
    {
      principalScope: 'fixture',
      ...(step ? { sessionId: step.sessionId as SessionId } : {}),
      recovery: saver.recovery,
      agent: {
        baseUrl: new URL('/conformance/candidate/', location.href).href,
        files: [
          'tool_candidate.py',
          'tool_scope.py',
          'tool_scoped_candidate.py',
          'tool_scoped_floor.py',
          'tool_identity_probes.py',
        ],
        module: 'tool_scoped_floor',
        entry: 'create_agent',
      },
      services: {
        chatModels: { mock: model },
        checkpoints: {
          async request(value: unknown): Promise<unknown> {
            const parsed = parseByteRequest(value);
            if (
              probe === 'crash' &&
              !step &&
              parsed.op === 'put-writes' &&
              parsed.writes.some((write) =>
                new TextDecoder().decode(write.value.bytes).includes('saved'),
              )
            ) {
              intercepted.resolve();
              await held.promise;
            }
            return saver.byteRecords.request(value);
          },
        },
      },
      confirmations: confirmationsFor(['write@1'], 'candidate-reload-v1'),
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            features: ['streaming', 'tool-calling'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
      },
      bindings: {
        'read@1': {
          ...binding,
          kind: 'read',
          approval: 'none',
          invoke: async (value, context) => {
            calls.push(['read@1', value]);
            effects.push(context.effectId);
            return '4';
          },
        },
        'write@1': {
          ...binding,
          kind: 'write',
          approval: 'confirm',
          invoke: async (value, context) => {
            calls.push(['write@1', value]);
            effects.push(context.effectId);
            return 'saved';
          },
        },
      },
    },
  );
  let abandon = false;
  const approve = setInterval(() => {
    for (const item of instance.getSnapshot().confirmations ?? [])
      instance.respond(item.id, 'approve');
  }, 5);
  try {
    await instance.prepare();
    const run = step
      ? await instance.restore()
      : await instance.start({
          scenario: probe === 'reads' ? 'parallel' : probe === 'writes' ? 'two-writes' : 'write',
          replay: probe !== 'crash',
        });
    const receiptIds = step?.effects ?? effects;
    if (step && probe === 'crash') {
      let startCode = '';
      try {
        await instance.start(null);
      } catch (error) {
        startCode = String(Reflect.get(error as object, 'code'));
      }
      return {
        sessionId: instance.sessionId,
        calls,
        effects,
        scopes,
        receipts: await Promise.all(
          receiptIds.map((id) => saver.recovery.effect(instance.sessionId, id as never)),
        ),
        restoreMissing: run === undefined,
        startCode,
      };
    }
    if (!run) throw new Error('Missing candidate run.');
    const restored = instance.getSnapshot().run?.pending;
    if (step) {
      if (!restored) throw new Error('Missing candidate pending interaction.');
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...restored,
        action: 'submit',
        payload: false,
      });
      if (receipt.status !== 'accepted') throw new Error('Candidate answer rejected.');
    }
    const collect = (async (): Promise<{ pending?: PendingInteraction; final?: unknown }> => {
      let final: unknown;
      for await (const event of instance.events(run.runId)) {
        if (event.type === 'error') throw new Error(event.error.code);
        if (event.type === 'interaction' && !step) {
          const pending = instance.getSnapshot().run?.pending;
          if (!pending) throw new Error('Missing candidate pause.');
          return { pending };
        }
        if (event.type === 'output') final = event.output;
      }
      return { final };
    })();
    if (probe === 'crash' && !step) {
      await Promise.race([
        intercepted.promise,
        collect.then(() => {
          throw new Error('Crash window was missed.');
        }),
      ]);
      abandon = true;
      void collect.catch(() => {});
      return {
        sessionId: instance.sessionId,
        calls,
        effects,
        scopes,
        receipts: await Promise.all(
          effects.map((id) => saver.recovery.effect(instance.sessionId, id as never)),
        ),
        crashReady: true,
      };
    }
    const summary = await collect;
    return {
      sessionId: instance.sessionId,
      calls,
      effects,
      scopes,
      receipts: await Promise.all(
        receiptIds.map((id) => saver.recovery.effect(instance.sessionId, id as never)),
      ),
      ...(restored ? { restored } : {}),
      ...summary,
    };
  } finally {
    clearInterval(approve);
    if (!abandon) {
      held.resolve();
      await runtime.dispose();
    }
    // The crash probe intentionally leaves this Worker and its held checkpoint for page.reload().
  }
}
