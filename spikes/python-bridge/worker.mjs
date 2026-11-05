// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const port = isNode ? (await import('node:worker_threads')).parentPort : globalThis;
const send = (message) => port.postMessage(JSON.stringify(message));
const pending = new Map();
const CANCELLED = { code: 'cancelled', message: 'The run was cancelled.' };
let py;
let sequence = 0;
const downloads = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  downloads.push({
    url: response.url,
    status: response.status,
    bytes: bytes.byteLength,
    sha256: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(''),
  });
  return response;
};

function bridge(raw) {
  const request = JSON.parse(raw);
  const id = `rpc-${++sequence}`;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    send({ v: 'galaxie.bridge/v1', kind: 'request', id, ...request });
  });
}

async function command(message) {
  const started = performance.now();
  if (message.op === 'boot') {
    const { loadPyodide } = isNode
      ? await import('pyodide')
      : await import(/* @vite-ignore */ `${message.origin}/node_modules/pyodide/pyodide.mjs`);
    py = await loadPyodide({
      packageBaseUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/',
      ...(isNode
        ? { packageCacheDir: message.cacheDir }
        : { indexURL: `${message.origin}/node_modules/pyodide/` }),
      stdout: (value) => send({ kind: 'log', value }),
      stderr: (value) => send({ kind: 'log', value }),
    });
    const runtimeMs = performance.now() - started;
    await py.loadPackage('micropip');
    py.globals.set('spike_origin', message.origin);
    await py.runPythonAsync(`
import micropip
await micropip.install(spike_origin + '/.cache/ormsgpack-1.13.0-py3-none-any.whl')
await micropip.install('https://files.pythonhosted.org/packages/f1/9a/7a0a0dad166db9f4437f3d259e47ce74d552ccc50d8aa63d05b2510e3096/uuid_utils-0.19.0-cp310-abi3-pyemscripten_2026_0_wasm32.whl#sha256=23868cdc4dfa71021fec6cf43fbb83797345362ac1c866b50dbf17f479587413')
from pyodide.http import pyfetch
requirements = await (await pyfetch(spike_origin + '/requirements.json')).json()
await micropip.install(requirements)
`);
    py.globals.set('bridge_json', bridge);
    await py.runPythonAsync(await (await fetch(`${message.origin}/agent.py`)).text());
    const versions = py.runPython('versions_json()');
    return {
      runtimeMs,
      readyMs: performance.now() - started,
      versions: JSON.parse(versions),
      downloads,
    };
  }
  if (message.op === 'busy') {
    send({ v: message.v, kind: 'busy-started', id: message.id });
    return py.runPython('while True: pass');
  }
  py.globals.set('command_json', JSON.stringify(message));
  return JSON.parse(await py.runPythonAsync('await execute_json(command_json)'));
}

function receive(raw) {
  let message;
  try {
    if (typeof raw !== 'string' || raw.length > 1_000_000) throw Error();
    message = JSON.parse(raw);
    if (message.v !== 'galaxie.bridge/v1' || typeof message.id !== 'string') throw Error();
    if (message.kind === 'response') {
      if (!pending.has(message.id) || typeof message.ok !== 'boolean') throw Error();
      const deferred = pending.get(message.id);
      if (message.ok && (!message.value || typeof message.value !== 'object')) throw Error();
      if (!message.ok && !['invalid', 'unavailable', 'cancelled'].includes(message.error?.code))
        throw Error();
      pending.delete(message.id);
      deferred.resolve(
        JSON.stringify(
          message.ok ? { ok: true, value: message.value } : { ok: false, error: message.error },
        ),
      );
      return;
    }
    if (message.kind === 'abort') {
      for (const deferred of pending.values())
        deferred.resolve(JSON.stringify({ ok: false, error: CANCELLED }));
      pending.clear();
      send({ v: message.v, kind: 'aborted', id: message.id });
      return;
    }
    if (
      message.kind !== 'command' ||
      !['boot', 'graph', 'resume', 'agent', 'abortProbe', 'busy'].includes(message.op)
    )
      throw Error();
  } catch {
    send({ kind: 'rejected', code: 'invalid', message: 'The bridge message is invalid.' });
    return;
  }
  command(message).then(
    (value) => send({ v: message.v, kind: 'result', id: message.id, value }),
    (error) => {
      // Throwaway debugging is host-only; failures on the wire use fixed text.
      console.error(error);
      send({
        v: message.v,
        kind: 'failure',
        id: message.id,
        code: 'unavailable',
        message: 'The worker command failed.',
      });
    },
  );
}
if (isNode) port.on('message', receive);
else port.addEventListener('message', (event) => receive(event.data));
