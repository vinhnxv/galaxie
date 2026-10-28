// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { MockArm } from './arms/mock.js';
import { OrtArm } from './arms/ort/index.js';
import type { Arm } from './arms/types.js';
import { deviceInfo, gpuProbe, promptAvailability } from './device.js';
import { armResult, runArm, selectedArms } from './harness.js';
import { downloadResults, emptyChatCheck, type ResultsV1, resultsSchema } from './results.js';

const params = new URLSearchParams(location.search);
const runButton = document.querySelector<HTMLButtonElement>('#run');
const download = document.querySelector<HTMLButtonElement>('#download');
const output = document.querySelector('#results');
const statusLabel = document.querySelector('#status');
const armOrder = selectedArms(params.get('arms'));
const requestedRuns = Number(params.get('runs') ?? 5);
const runs = Number.isSafeInteger(requestedRuns) && requestedRuns > 0 ? requestedRuns : 5;
const device = await deviceInfo();
const prompt = await promptAvailability();
let results: ResultsV1 = {
  schema: 'galaxie.spike-b.results/v1',
  createdAt: new Date().toISOString(),
  page: { origin: location.origin },
  device,
  armOrder,
  runs,
  arms: [],
  chatWebLLM: emptyChatCheck('webllm_not_run'),
  promptApiAvailability: prompt,
};
let running = false;
let done = false;
let error: string | null = null;
function render(message: string): void {
  if (statusLabel) statusLabel.textContent = message;
  if (output) output.textContent = JSON.stringify(resultsSchema.parse(results), null, 2);
}
const mock = new MockArm(params.get('mockFail'));
// Real arms are added in their implementation units; probes never load a model.
const arms: Arm[] = [
  mock,
  new OrtArm(),
  ...armOrder
    .filter((id) => id !== 'mock' && id !== 'ort-own-loop')
    .map((id) => ({
      id,
      model: { id: 'pending', revision: null },
      engineVersion: 'pending',
      inWorker: id !== 'prompt-api',
      decoding: id === 'prompt-api' ? ('browser-default' as const) : ('greedy' as const),
      schemaMechanism: 'pending',
      sameCheckpointAs: null,
      probe: async () =>
        id === 'prompt-api'
          ? { status: 'unavailable' as const, reason: 'api_missing' as const, raw: prompt.en }
          : gpuProbe(),
      load: async () => {
        throw new Error('not_implemented');
      },
      openSession: async () => {
        throw new Error('not_implemented');
      },
      dispose: async () => {},
    })),
];
for (const id of armOrder) {
  const arm = arms.find((arm) => arm.id === id);
  if (arm) {
    const record = armResult(arm);
    record.availability = await arm.probe();
    results.arms.push(record);
  }
}
async function runAll(options: { runs?: number } = {}): Promise<void> {
  if (running) return;
  running = true;
  done = false;
  error = null;
  if (runButton) runButton.disabled = true;
  if (download) download.disabled = true;
  results = {
    ...results,
    createdAt: new Date().toISOString(),
    runs: options.runs ?? runs,
    arms: [],
  };
  try {
    for (const id of armOrder) {
      const arm = arms.find((arm) => arm.id === id);
      if (arm)
        results.arms.push(
          await runArm(arm, {
            runs: results.runs,
            probeReal: params.get('probe') === 'real',
            promptProbe: params.get('promptApi') === 'probe',
            promptVi: prompt.vi,
            progress: render,
          }),
        );
    }
    results = resultsSchema.parse(results);
    done = true;
    render('Finished');
  } catch {
    error = 'harness_failed';
    render('Harness failed');
  } finally {
    running = false;
    if (runButton) runButton.disabled = false;
    if (download) download.disabled = false;
  }
}
export interface SpikeHandle {
  results(): ResultsV1;
  runAll(options?: { runs?: number }): Promise<void>;
  status(): { done: boolean; running: boolean; error: string | null };
}
declare global {
  interface Window {
    spikeB: SpikeHandle;
  }
}
if (import.meta.env.DEV || import.meta.env.MODE === 'smoke')
  window.spikeB = {
    results: () => resultsSchema.parse(results),
    runAll,
    status: () => ({ done, running, error }),
  };
const label = document.querySelector('#device');
if (label) label.textContent = JSON.stringify(device);
if (runButton) {
  runButton.disabled = false;
  runButton.onclick = () => {
    void runAll();
  };
}
if (download) {
  download.disabled = false;
  download.onclick = () => downloadResults(results);
}
render('Ready');
