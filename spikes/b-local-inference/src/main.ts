// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { deviceInfo, gpuProbe, promptAvailability } from './device.js';
import { downloadResults, emptyChatCheck, type ResultsV1, resultsSchema } from './results.js';

const device = await deviceInfo();
const results: ResultsV1 = resultsSchema.parse({
  schema: 'galaxie.spike-b.results/v1',
  createdAt: new Date().toISOString(),
  page: { origin: location.origin },
  device,
  arms: [],
  armOrder: [],
  runs: 5,
  chatWebLLM: emptyChatCheck('webllm_not_run'),
  promptApiAvailability: await promptAvailability(),
});
const output = document.querySelector('#results');
if (output) output.textContent = JSON.stringify(results, null, 2);
const label = document.querySelector('#device');
if (label) label.textContent = JSON.stringify(device);
const download = document.querySelector<HTMLButtonElement>('#download');
if (download) {
  download.disabled = false;
  download.onclick = () => downloadResults(results);
}

const probes = document.createElement('pre');
probes.textContent = JSON.stringify(
  {
    mock: { status: 'available' },
    'ort-own-loop': await gpuProbe(),
    webllm: await gpuProbe(),
    'transformers-js': await gpuProbe(),
    'prompt-api': results.promptApiAvailability,
  },
  null,
  2,
);
document.querySelector('main')?.append(probes);
