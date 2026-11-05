// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';
import type { LockedWheel } from '../src/runtime-files.js';

const { source, wheels, absent } = workerData as {
  source: string;
  wheels: readonly LockedWheel[];
  absent?: readonly string[];
};
let fetches = 0;
globalThis.fetch = async (): Promise<Response> => {
  fetches++;
  throw new Error('The gate forbids network fetch.');
};
const py = await loadPyodide({
  indexURL: fileURLToPath(new URL('../node_modules/pyodide/', import.meta.url)),
  packageCacheDir: fileURLToPath(new URL('../../../.cache/python-wheels/', import.meta.url)),
  lockFileContents: {
    info: {
      version: '314.0.7',
      abi_version: '2026_0',
      arch: 'wasm32',
      platform: 'emscripten_5_0_3',
      python: '3.14.2',
    },
    packages: Object.fromEntries(
      wheels.map((wheel) => [
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
  wheels.map((wheel) => wheel.name),
  { checkIntegrity: true, messageCallback: () => {}, errorCallback: () => {} },
);
const result = await py.runPythonAsync(
  `import importlib.util\nfor _name in ${JSON.stringify(absent ?? ['openai', 'litellm'])}:\n    assert importlib.util.find_spec(_name) is None\n${source}\njson.dumps(await run_gate())`,
);
parentPort?.postMessage({ gate: JSON.parse(result as string), fetches });
