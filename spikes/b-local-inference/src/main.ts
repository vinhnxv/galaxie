// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { MockArm } from './arms/mock.js';
import { OrtArm } from './arms/ort/index.js';
import { PromptArm } from './arms/prompt-api.js';
import { TransformersArm } from './arms/transformers.js';
import type { Arm } from './arms/types.js';
import { WebLLMArm } from './arms/webllm.js';
import { chatWebLLMCheck } from './chat-webllm-check.js';
import { deviceInfo, type PromptSession, promptAvailability } from './device.js';
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
function createPromptWithActivation(create: () => Promise<PromptSession>): Promise<PromptSession> {
  if (navigator.userActivation.isActive) return create();
  if (!runButton) return Promise.reject(new Error('run_button_missing'));
  render('Prompt API download needs another click on Run after earlier arms used the activation.');
  runButton.disabled = false;
  return new Promise((resolve, reject) => {
    runButton.addEventListener(
      'click',
      () => {
        runButton.disabled = true;
        void create().then(resolve, reject);
      },
      { once: true },
    );
  });
}
const mock = new MockArm(params.get('mockFail'));
const arms: Arm[] = [
  mock,
  new OrtArm(),
  new WebLLMArm(),
  new TransformersArm(),
  new PromptArm(createPromptWithActivation),
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
    chatWebLLM: emptyChatCheck('webllm_not_run'),
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
            beforeDispose: async (arm) => {
              if (arm instanceof WebLLMArm) {
                try {
                  results.chatWebLLM = await arm.guard(chatWebLLMCheck(arm));
                } catch {
                  results.chatWebLLM = { ...emptyChatCheck('check_exception'), status: 'failed' };
                }
              }
            },
          }),
        );
    }
    const webllm = results.arms.find((arm) => arm.id === 'webllm');
    const transformers = results.arms.find((arm) => arm.id === 'transformers-js');
    if (
      webllm &&
      transformers &&
      transformers.model.id === 'onnx-community/Qwen2.5-1.5B-Instruct'
    ) {
      webllm.sameCheckpointAs = 'transformers-js';
      transformers.sameCheckpointAs = 'webllm';
    } else {
      if (webllm) webllm.sameCheckpointAs = null;
      if (transformers) transformers.sameCheckpointAs = null;
    }
    if (results.chatWebLLM.status === 'not_run') {
      const record = results.arms.find((arm) => arm.id === 'webllm');
      const reason = !record
        ? 'webllm_not_selected'
        : params.get('probe') === 'real'
          ? 'probe_only'
          : record.availability.status === 'unavailable'
            ? 'webllm_unavailable'
            : record.error === 'load_failed'
              ? 'webllm_load_failed'
              : 'webllm_check_not_reached';
      results.chatWebLLM = emptyChatCheck(reason);
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
