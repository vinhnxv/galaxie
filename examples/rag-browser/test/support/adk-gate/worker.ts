// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { LockedWheel } from '../../../../../packages/adapter-pyodide/src/runtime-files.js';

declare const ADK_GATE_SOURCE: string;
declare const ADK_GATE_WHEELS: readonly LockedWheel[];

Reflect.set(globalThis, 'importScripts', (): never => {
  throw new TypeError('Classic scripts are unavailable in a module Worker.');
});
const violations: string[] = [];
let networkAttempts = 0;
addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
try {
  const { loadPyodide } = await import(
    '../../../../../packages/adapter-pyodide/node_modules/pyodide/pyodide.js'
  );
  const py = await loadPyodide({
    indexURL: new URL('/python/runtime/', location.href).href,
    packageBaseUrl: new URL('/python/wheels/', location.href).href,
    lockFileContents: {
      info: {
        version: '314.0.7',
        abi_version: '2026_0',
        arch: 'wasm32',
        platform: 'emscripten_5_0_3',
        python: '3.14.2',
      },
      packages: Object.fromEntries(
        ADK_GATE_WHEELS.map((wheel) => [
          wheel.name,
          {
            name: wheel.name,
            version: wheel.version,
            file_name: wheel.file,
            sha256: wheel.sha256,
            depends: [],
            imports: [],
            install_dir: 'site' as const,
            package_type: 'package' as const,
          },
        ]),
      ),
    },
    stdout: () => {},
    stderr: () => {},
  });
  await py.loadPackage(
    ADK_GATE_WHEELS.map((wheel) => wheel.name),
    { checkIntegrity: true, messageCallback: () => {}, errorCallback: () => {} },
  );
  const forbid = (): never => {
    networkAttempts++;
    throw new Error('The gate forbids network access.');
  };
  globalThis.fetch = async (): Promise<Response> => forbid();
  Reflect.set(globalThis, 'WebSocket', function WebSocket() {
    forbid();
  });
  Reflect.set(globalThis, 'XMLHttpRequest', function XMLHttpRequest() {
    forbid();
  });
  const result = await py.runPythonAsync(
    `import importlib.util\nfor _name in ['uvicorn', 'watchdog', 'grpc', 'aiosqlite', 'mcp', 'opentelemetry.sdk']:\n    assert importlib.util.find_spec(_name) is None\n${ADK_GATE_SOURCE}\njson.dumps(await run_gate())`,
  );
  postMessage({ result: JSON.parse(result as string), violations, networkAttempts });
} catch (error) {
  postMessage({ error: String(error), violations, networkAttempts });
}
