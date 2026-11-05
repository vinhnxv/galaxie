// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type GoLoadTimings,
  loadGoWasm,
  workerLoaderEnvironment,
} from '../../../../../packages/adapter-go/src/loader.js';

export interface GateConfig {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The smallest valid module: a header and nothing else. */
const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** Compiles an empty module and returns the browser's refusal message, or null when it compiles. */
export async function probeCompile(): Promise<string | null> {
  try {
    await WebAssembly.compile(emptyModule);
    return null;
  } catch (error) {
    return String(error);
  }
}

export interface GateReport {
  readonly scenarios: Record<string, unknown>;
  readonly egress: unknown;
  readonly egressAttempts: number;
  readonly timings: GoLoadTimings;
  readonly violations: string[];
  readonly compileProbe: string | null;
  readonly error?: string;
}

interface GateApi {
  readonly scenarios: string;
  run(name: string): Promise<string>;
}

/**
 * Loads the gate module through the shipped loader, runs every scenario against a scripted JS
 * host and reports the records. The caller must have evaluated `wasm_exec.js` first.
 */
export async function drive(
  config: GateConfig,
  violations: string[],
  compileProbe: string | null,
): Promise<GateReport> {
  const scope = globalThis as unknown as Record<string, unknown>;
  // The JavaScript side of the capability bridge: doubling, a rejection and a call that never ends.
  scope['galaxieHost'] = {
    capability(name: string, value: number): Promise<number> {
      if (name === 'hang') return new Promise(() => undefined);
      if (value < 0) return Promise.reject(new Error('the host rejected a negative value'));
      return Promise.resolve(value * 2);
    },
  };
  const loaded = await loadGoWasm(
    { url: config.url, sha256: config.sha256, bytes: config.bytes },
    workerLoaderEnvironment(scope),
  );
  const api = scope['galaxieGate'] as GateApi;
  const names = JSON.parse(api.scenarios) as string[];
  const scenarios: Record<string, unknown> = {};
  for (const name of names) scenarios[name] = JSON.parse(await api.run(name));
  const egress: unknown = JSON.parse(await api.run('egress-http'));
  return {
    scenarios,
    egress,
    egressAttempts: loaded.egressAttempts(),
    timings: loaded.timings,
    violations,
    compileProbe,
  };
}
