// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { LockedWheel } from '../../../../../packages/adapter-pyodide/src/runtime-files.js';

declare const DSPY_GATE_SOURCE: string;
declare const DSPY_GATE_WHEELS: readonly LockedWheel[];

Reflect.set(globalThis, 'importScripts', (): never => {
  throw new TypeError('Classic scripts are unavailable in a module Worker.');
});
const violations: string[] = [];
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
        DSPY_GATE_WHEELS.map((wheel) => [
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
    DSPY_GATE_WHEELS.map((wheel) => wheel.name),
    { checkIntegrity: true, messageCallback: () => {}, errorCallback: () => {} },
  );
  globalThis.fetch = async (): Promise<Response> => {
    throw new Error('The gate forbids network fetch.');
  };
  const result = await py.runPythonAsync(
    `import importlib.util\nassert importlib.util.find_spec('openai') is None\nassert importlib.util.find_spec('litellm') is None\n${DSPY_GATE_SOURCE}\njson.dumps(await run_gate())`,
  );
  postMessage({ result: JSON.parse(result as string), violations });
} catch (error) {
  postMessage({ error: String(error), violations });
}
