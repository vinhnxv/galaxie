// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on('message', async (result) => {
    await writeFile(
      new URL('./dependency-probe.json', import.meta.url),
      JSON.stringify(result, null, 2),
    );
    console.log(result);
    await worker.terminate();
  });
  worker.on('error', (error) => {
    throw error;
  });
} else {
  const py = await loadPyodide({
    packageBaseUrl: 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/',
    // Without this, Node Pyodide caches wheels under a cwd-relative path named after the URL.
    packageCacheDir: fileURLToPath(new URL('./.cache/pyodide-packages/', import.meta.url)),
    stdout: console.log,
    stderr: console.error,
  });
  await py.loadPackage('micropip');
  const result = await py.runPythonAsync(`
import importlib.metadata
import json
import micropip
results = []
for package in ["langchain-core==1.7.3", "langgraph-checkpoint==4.3.1", "uuid-utils==0.19.0", "ormsgpack==1.13.0", "langchain-core==1.7.3", "pydantic-ai-slim==2.63.0"]:
    try:
        await micropip.install(package, keep_going=True)
        results.append({"package": package, "installed": True})
    except Exception as error:
        results.append({"package": package, "installed": False, "error": str(error)})
import httpx2
from pydantic_ai import Agent
json.dumps({"results": results, "httpx2": importlib.metadata.version("httpx2"), "agent_import": True})
`);
  parentPort.postMessage(JSON.parse(result));
}
