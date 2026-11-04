// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The hash-checked glue file defines `Go` on the global before the loader runs.
import '../../../../../.cache/go-wasm/wasm_exec.js';
import { drive, type GateConfig, probeCompile } from './scenario-driver.js';

Reflect.set(globalThis, 'importScripts', (): never => {
  throw new TypeError('Classic scripts are unavailable in a module Worker.');
});
const violations: string[] = [];
addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
addEventListener('message', (event: MessageEvent<GateConfig>) => {
  void (async () => {
    const compileProbe = await probeCompile();
    try {
      postMessage(await drive(event.data, violations, compileProbe));
    } catch (error) {
      postMessage({ error: String(error), violations, compileProbe });
    }
  })();
});
