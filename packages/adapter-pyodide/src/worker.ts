// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ErrorCode } from '@galaxie-ai/core';
import { adkDriver, adkImportProbe } from './adk-python-driver.js';
import {
  type BootPayload,
  BRIDGE_VERSION,
  type BridgeMessage,
  encodeBridge,
  failure,
  parseBridge,
  type RunPayload,
  success,
} from './bridge.js';
import { dspyDriver } from './dspy-driver.js';
import { adapterFailure, failureCode } from './errors.js';
import { pydanticAiDriver } from './pydantic-ai-driver.js';
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
let active: { id: string; settled: Promise<void>; modelReplies: Promise<string>[] } | undefined;
let reading: { id: string } | undefined;
const pending = new Map<string, { request: BridgeMessage; resolve(value: string): void }>();
async function boot(input: BootPayload): Promise<number> {
  const started = performance.now();
  const framework = input.framework ?? 'langgraph';
  const all = [...lockedWheels, ...input.localWheels].filter(
    (wheel) => wheel.frameworks === undefined || wheel.frameworks.includes(framework),
  );
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
  // In Node, Pyodide caches packages under packageBaseUrl taken as a relative path; keep that
  // copy of the verified bytes in a private temporary directory removed after installation.
  const fs = node ? await import('node:fs') : undefined;
  const cache = fs?.mkdtempSync(`${(await import('node:os')).tmpdir()}/galaxie-pyodide-`);
  const removeCache = (): void => {
    if (cache !== undefined) fs?.rmSync(cache, { recursive: true, force: true });
  };
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
    ...(cache === undefined ? {} : { packageCacheDir: cache }),
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
  }).catch((error: unknown) => {
    removeCache();
    throw error;
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
    removeCache();
  }
  await py.runPythonAsync(
    framework === 'adk'
      ? adkImportProbe
      : framework === 'dspy'
        ? 'import dspy\nimport galaxie'
        : framework === 'pydantic-ai'
          ? 'import pydantic_ai\nimport galaxie'
          : 'import langgraph.graph\nimport langchain_core.messages\nimport galaxie\nimport ormsgpack',
  );
  py.FS.mkdirTree('/agent');
  for (const source of input.sources) {
    const destination = `/agent/${source.path}`;
    py.FS.mkdirTree(destination.slice(0, destination.lastIndexOf('/')));
    py.FS.writeFile(destination, source.text);
  }
  py.registerJsModule('_galaxie_transport', {
    notify(raw: string): void {
      const message = parseBridge(raw);
      if (!active || message.kind !== 'notify' || message.op !== 'stream')
        throw adapterFailure('invalid');
      send({ ...message, id: `${active.id}/${message.id}` });
    },
    request(raw: string): Promise<string> {
      const message = parseBridge(raw);
      const context = active ?? reading;
      if (
        !context ||
        message.kind !== 'request' ||
        !['model', 'capability', 'checkpoint'].includes(message.op) ||
        (!active &&
          (message.op !== 'checkpoint' ||
            !['get', 'list'].includes((message.payload as { op: string }).op)))
      )
        throw new Error('invalid');
      const id = `${context.id}/${message.id}`;
      const reply = Promise.withResolvers<string>();
      pending.set(id, { request: message, resolve: reply.resolve });
      if (
        message.op === 'model' &&
        (message.payload as { options: { stream?: boolean } }).options.stream
      )
        active?.modelReplies.push(reply.promise);
      send({ ...message, id });
      return reply.promise;
    },
  });
  py.globals['set']('_galaxie_module', input.module);
  if (framework === 'adk') py.globals['set']('_galaxie_roles', JSON.stringify(input.roles ?? []));
  py.globals['set']('_galaxie_entry', input.entry);
  py.globals['set']('_galaxie_durable', input.checkpoints === true);
  await py.runPythonAsync(
    framework === 'adk'
      ? adkDriver
      : framework === 'dspy'
        ? dspyDriver
        : framework === 'pydantic-ai'
          ? pydanticAiDriver
          : `
import sys, json, asyncio, importlib
from galaxie._bridge import install_transport, GalaxieError, notify_stream, receive_model_chunk
from _galaxie_transport import request as _transport, notify as _notify
from langgraph.errors import GraphRecursionError
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command
from galaxie.langgraph import _install_checkpointer, checkpointer, GalaxieCheckpointer
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
_install_checkpointer(GalaxieCheckpointer() if _galaxie_durable else InMemorySaver())
try:
    _galaxie_graph = getattr(importlib.import_module(_galaxie_module), _galaxie_entry)()
    if getattr(_galaxie_graph, 'checkpointer', None) is not checkpointer():
        raise GalaxieError('unsupported')
    _galaxie_ready = {'ok': True}
except GalaxieError as error:
    _galaxie_ready = {'ok': False, 'code': error.code}
except Exception:
    _galaxie_ready = {'ok': False, 'code': 'unavailable'}
def _galaxie_json(value):
    try:
        return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, UnicodeError):
        raise GalaxieError('unsupported') from None
async def _galaxie_pending():
    try:
        state = await _galaxie_graph.aget_state({'configurable': {'thread_id': _galaxie_thread}})
        interrupts = [item for task in state.tasks for item in task.interrupts]
        return _galaxie_json({'ok': True, 'interrupts': [
            {'value': item.value, **({'id': item.id} if getattr(item, 'id', None) is not None else {})}
            for item in interrupts
        ]})
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    try:
        payload = json.loads(_galaxie_input)
        config = {'configurable': {'thread_id': payload['threadId']}, 'recursion_limit': payload['steps']}
        configured = (_galaxie_graph.config or {}).get('recursion_limit')
        if type(configured) is int and configured > 0:
            config['recursion_limit'] = min(config['recursion_limit'], configured)
        value = payload.get('input')
        if 'resume' in payload:
            resume = payload['resume']
            state = await _galaxie_graph.aget_state(config)
            ids = {getattr(item, 'id', None) for task in state.tasks for item in task.interrupts}
            if ids != {resume['interactionId']}:
                raise GalaxieError('unsupported')
            value = Command(resume={resume['interactionId']: {
                'action': resume['action'], 'payload': resume['payload'],
            }})
        output = None
        interrupted = False
        async for path, mode, data in _galaxie_graph.astream(
            value, config, stream_mode=['values', 'updates', 'messages', 'custom'],
            subgraphs=True, output_keys=_galaxie_graph.output_channels,
        ):
            notify_stream(path, mode, data)
            if not path and mode == 'values':
                output = data
            if not path and mode == 'updates' and isinstance(data, dict) and '__interrupt__' in data:
                interrupted = True
        return _galaxie_json({'ok': True, **({'interrupted': True} if interrupted else {'output': output})})
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except GraphRecursionError:
        return json.dumps({'ok': False, 'code': 'budget_exceeded'})
    except asyncio.CancelledError:
        return json.dumps({'ok': False, 'code': 'cancelled'})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
`,
  );
  const ready = JSON.parse(py.runPython('json.dumps(_galaxie_ready)')) as {
    ok: boolean;
    code: ErrorCode;
  };
  if (!ready.ok) throw adapterFailure(ready.code);
  python = py;
  return performance.now() - started;
}
async function receive(data: unknown): Promise<void> {
  let request: BridgeMessage;
  try {
    request = parseBridge(data);
  } catch (error) {
    send({
      v: BRIDGE_VERSION,
      kind: 'response',
      id: 'invalid',
      op: 'boot',
      ok: false,
      error: { code: failureCode(error, 'invalid') },
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
  if (request.kind === 'notify') {
    const call = pending.get(request.id);
    if (
      request.op !== 'model-chunk' ||
      !active ||
      !python ||
      !request.id.startsWith(`${active.id}/`) ||
      call?.request.kind !== 'request' ||
      call.request.op !== 'model' ||
      (call.request.payload as { options: { stream?: boolean } }).options.stream !== true
    ) {
      send(failure(request, 'invalid'));
      return;
    }
    try {
      python.globals['set'](
        '_galaxie_notification',
        encodeBridge({ ...request, id: call.request.id }),
      );
      python.runPython('receive_model_chunk(_galaxie_notification)');
    } catch (error) {
      send(failure(request, failureCode(error, 'invalid')));
    }
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
      if (!python || active || reading) {
        send(failure(request, 'invalid', 'result'));
        return;
      }
      const py = python;
      const payload = request.payload as RunPayload;
      py.globals['set']('_galaxie_input', JSON.stringify(payload));
      const done = Promise.withResolvers<void>();
      active = { id: request.id, settled: done.promise, modelReplies: [] };
      try {
        const value = JSON.parse(await py.runPythonAsync('await _galaxie_execute()')) as {
          ok: boolean;
          output?: unknown;
          interrupted?: true;
          code?: string;
        };
        if (value.ok) {
          // Public model streams may close before their inner generator drains the call.
          // Keep the run context alive through checked deltas and terminal settlement.
          const replies = await Promise.all(active.modelReplies);
          for (const raw of replies) {
            const reply = parseBridge(raw);
            if (reply.kind !== 'response') throw adapterFailure('invalid');
            if (!reply.ok) throw adapterFailure(reply.error.code);
          }
          send(
            success(
              request,
              value.interrupted ? { interrupted: true } : { output: value.output },
              'result',
            ),
          );
        } else send(failure(request, value.code as ErrorCode, 'result'));
      } catch (error) {
        send(failure(request, failureCode(error, 'executor_error'), 'result'));
      } finally {
        active = undefined;
        for (const [id, call] of pending) {
          call.resolve(encodeBridge(failure(call.request, 'cancelled')));
          pending.delete(id);
        }
        done.resolve();
      }
    } else if (request.op === 'pending') {
      if (!python || active || reading) {
        send(failure(request, 'invalid'));
        return;
      }
      reading = { id: request.id };
      try {
        python.globals['set'](
          '_galaxie_thread',
          (request.payload as { threadId: string }).threadId,
        );
        const state = JSON.parse(await python.runPythonAsync('await _galaxie_pending()')) as {
          ok: boolean;
          code: ErrorCode;
          interrupts: unknown;
        };
        send(
          state.ok
            ? success(request, { interrupts: state.interrupts })
            : failure(request, state.code),
        );
      } finally {
        reading = undefined;
      }
    } else if (request.op === 'abort') {
      if (active && (request.payload as { runId: string }).runId === active.id) {
        const settlement = active.settled;
        python?.runPython('_galaxie_task.cancel()');
        await settlement;
      }
      send(success(request, null));
    } else send(failure(request, 'invalid'));
  } catch (error) {
    send(
      failure(
        request,
        failureCode(error, request.op === 'boot' ? 'unavailable' : 'executor_error'),
      ),
    );
  }
}
if (node) {
  parent = (await import('node:worker_threads')).parentPort;
  parent?.on('message', receive);
} else
  addEventListener('message', (event) => {
    void receive(event.data);
  });
