// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorCode } from '@galaxie/core';
import {
  type BootPayload,
  type BridgeMessage,
  encodeBridge,
  failure,
  parseBridge,
  success,
} from './bridge.js';
import { lockedWheels } from './runtime-files.js';

// Module Workers cannot run classic scripts. Pyodide probes importScripts with a data URL;
// fail before that unsupported call reaches a Trusted Types sink, keeping the CSP unchanged.
Reflect.set(globalThis, 'importScripts', (): never => {
  throw new TypeError('Classic scripts are unavailable in a module Worker.');
});

const node = typeof process !== 'undefined' && !!process.versions?.node;
let parent: import('node:worker_threads').MessagePort | null | undefined;
function send(value: BridgeMessage): void {
  const message = encodeBridge(value);
  if (parent) parent.postMessage(message);
  else globalThis.postMessage(message);
}
let python: Awaited<ReturnType<typeof import('pyodide').loadPyodide>> | undefined;
let booting = false;
let active: { id: string; settled: Promise<void> } | undefined;
const pending = new Map<string, { request: BridgeMessage; resolve(value: string): void }>();
async function boot(input: BootPayload): Promise<number> {
  const started = performance.now();
  const all = [...lockedWheels, ...input.localWheels];
  const verified = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const file of all) {
    const url = new URL(file.file, input.wheelsUrl).href;
    const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (bytes.length !== file.bytes || hash !== file.sha256) throw new Error('unavailable');
    verified.set(url, bytes);
  }
  const { loadPyodide } = await import('pyodide');
  const packages = Object.fromEntries(
    all.map((file) => [
      file.name.replaceAll('_', '-').toLowerCase(),
      {
        name: file.name,
        version: file.version,
        file_name: file.file,
        sha256: file.sha256,
        depends: [],
        imports: [],
        install_dir: 'site' as const,
        package_type: 'package' as const,
      },
    ]),
  );
  const py = await loadPyodide({
    indexURL: input.runtimeUrl,
    packageBaseUrl: input.wheelsUrl,
    lockFileContents: {
      info: {
        version: '314.0.7',
        abi_version: '2026_0',
        arch: 'wasm32',
        platform: 'emscripten_5_0_3',
        python: '3.14.2',
      },
      packages,
    },
    stdout: () => {},
    stderr: () => {},
    env: { LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' },
  });
  const originalFetch = globalThis.fetch;
  try {
    // Package loading consumes the bytes already verified above, without resolving dependencies
    // or requesting an index, CDN or mutable runtime lockfile.
    globalThis.fetch = async (request, options): Promise<Response> => {
      const url =
        typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      const bytes = verified.get(url);
      return bytes ? new Response(bytes) : originalFetch(request, options);
    };
    await py.loadPackage(Object.keys(packages), {
      checkIntegrity: true,
      messageCallback: () => {},
      errorCallback: () => {},
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  await py.runPythonAsync(
    'import langgraph.graph\nimport langchain_core.messages\nimport galaxie\nimport ormsgpack',
  );
  py.FS.mkdirTree('/agent');
  for (const source of input.sources) {
    const destination = `/agent/${source.path}`;
    py.FS.mkdirTree(destination.slice(0, destination.lastIndexOf('/')));
    py.FS.writeFile(destination, source.text);
  }
  py.registerJsModule('_galaxie_transport', {
    request(raw: string): Promise<string> {
      const message = parseBridge(raw);
      if (!active || message.kind !== 'request' || !['model', 'capability'].includes(message.op))
        throw new Error('invalid');
      const id = `${active.id}/${message.id}`;
      return new Promise((resolve) => {
        pending.set(id, { request: message, resolve });
        send({ ...message, id });
      });
    },
  });
  py.globals['set']('_galaxie_module', input.module);
  py.globals['set']('_galaxie_entry', input.entry);
  await py.runPythonAsync(`
import sys, json, asyncio, importlib
from galaxie._bridge import install_transport, GalaxieError
from _galaxie_transport import request as _transport
from langgraph.errors import GraphRecursionError
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request)
_galaxie_graph = getattr(importlib.import_module(_galaxie_module), _galaxie_entry)()
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    try:
        output = await _galaxie_graph.ainvoke(json.loads(_galaxie_input), config={'recursion_limit': _galaxie_steps})
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except GraphRecursionError:
        return json.dumps({'ok': False, 'code': 'budget_exceeded'})
    except asyncio.CancelledError:
        return json.dumps({'ok': False, 'code': 'cancelled'})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
`);
  python = py;
  return performance.now() - started;
}
async function receive(data: unknown): Promise<void> {
  let request: BridgeMessage;
  try {
    request = parseBridge(data);
  } catch {
    send({
      v: 'galaxie.bridge/v1',
      kind: 'response',
      id: 'invalid',
      op: 'boot',
      ok: false,
      error: { code: 'invalid' },
    });
    return;
  }
  if (request.kind === 'response') {
    const call = pending.get(request.id);
    if (!call || call.request.op !== request.op) return;
    pending.delete(request.id);
    call.resolve(encodeBridge({ ...request, id: call.request.id }));
    return;
  }
  try {
    if (request.op === 'boot') {
      if (python || active || booting) {
        send(failure(request, 'invalid'));
        return;
      }
      booting = true;
      try {
        const coldStartMs = await boot(request.payload as BootPayload);
        send(success(request, { coldStartMs }));
      } finally {
        booting = false;
      }
    } else if (request.op === 'run') {
      if (!python || active) {
        send(failure(request, 'invalid', 'result'));
        return;
      }
      const py = python;
      const payload = request.payload as { input: unknown; steps: number };
      py.globals['set']('_galaxie_input', JSON.stringify(payload.input));
      py.globals['set']('_galaxie_steps', payload.steps);
      const done = Promise.withResolvers<void>();
      active = { id: request.id, settled: done.promise };
      try {
        const value = JSON.parse(await py.runPythonAsync('await _galaxie_execute()')) as {
          ok: boolean;
          output?: unknown;
          code?: string;
        };
        if (value.ok) send(success(request, { output: value.output }, 'result'));
        else send(failure(request, value.code as ErrorCode, 'result'));
      } catch {
        send(failure(request, 'executor_error', 'result'));
      } finally {
        active = undefined;
        for (const [id, call] of pending) {
          call.resolve(encodeBridge(failure(call.request, 'cancelled')));
          pending.delete(id);
        }
        done.resolve();
      }
    } else if (request.op === 'abort') {
      if (active && (request.payload as { runId: string }).runId === active.id) {
        const settlement = active.settled;
        python?.runPython('_galaxie_task.cancel()');
        await settlement;
      }
      send(success(request, null));
    } else send(failure(request, 'invalid'));
  } catch {
    send(failure(request, request.op === 'boot' ? 'unavailable' : 'executor_error'));
  }
}
if (node) {
  parent = (await import('node:worker_threads')).parentPort;
  parent?.on('message', receive);
} else
  addEventListener('message', (event) => {
    void receive(event.data);
  });
