// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { BuiltinArm, type PromptSession } from './arms/builtin-ai.js';
import { MockArm } from './arms/mock.js';
import { OrtCandidate } from './arms/ort-candidate.js';
import type { Arm } from './arms/types.js';
import { deviceProfile } from './device.js';
import {
  applyReference,
  makeResults,
  type Observations,
  probeArms,
  type Reference,
  runArm,
  selectedArms,
} from './harness.js';
import { questions, validateAnswers } from './questions.js';
import { MOCK_BANNER, report } from './report.js';
import { download, downloadResults, inventory, type Results, resultsSchema } from './results.js';

declare global {
  interface Window {
    spikeDecision: {
      status(): { done: boolean; running: boolean; error: string | null };
      results(): Results | null;
      report(): string;
      importReference(value: unknown): void;
    };
  }
}
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error('page_element_missing');
  return found as T;
}
const run = element<HTMLButtonElement>('run');
const resultsButton = element<HTMLButtonElement>('download');
const reportButton = element<HTMLButtonElement>('report');
const releaseButton = element<HTMLButtonElement>('release');
const status = element<HTMLParagraphElement>('status');
const output = element<HTMLPreElement>('results');
const memoryArm = element<HTMLSelectElement>('memory-arm');
let current: Results | null = null;
let done = false;
let running = false;
let error: string | null = null;
let reference: Reference | null = null;
let activate: (() => void) | null = null;
let holdingModel = false;
const observations: Observations = new Map();
function render(): void {
  if (!current) return;
  const validated = resultsSchema.parse(current);
  output.textContent = `${validated.armOrder.includes('mock') ? `${MOCK_BANNER}\n\n` : ''}${JSON.stringify(validated, null, 2)}`;
  resultsButton.disabled = reportButton.disabled = running;
}
const referenceSchema = z.strictObject({
  candidateId: z.string(),
  revision: z.string(),
  answers: z
    .array(
      z.strictObject({
        id: z.string(),
        value: z.union([z.boolean(), z.string(), z.number().int()]),
      }),
    )
    .length(200),
});
function importReference(value: unknown): void {
  const parsed = referenceSchema.parse(value);
  const pinned = inventory.find((entry) => entry.id === parsed.candidateId);
  if (
    !(parsed.candidateId === 'deterministic-mock' && parsed.revision === 'v1') &&
    (!pinned?.revision || parsed.revision !== pinned.revision)
  )
    throw new Error('reference_not_pinned');
  validateAnswers(
    questions,
    parsed.answers.map((answer) => ({ ...answer, confidence: null })),
  );
  reference = parsed;
  if (current)
    for (const result of current.arms)
      applyReference(result, observations.get(result.id), reference);
  element('reference-status').textContent =
    'Pinned reference imported; agreement requires a matching browser run. Synthetic mock agreement is harness evidence only.';
  render();
}
window.spikeDecision = {
  status: () => ({ done, running, error }),
  results: () => (current ? resultsSchema.parse(current) : null),
  report: () => {
    if (!current) throw new Error('results_not_ready');
    return report(current);
  },
  importReference,
};
resultsButton.onclick = () => {
  if (current) downloadResults(current);
};
reportButton.onclick = () => {
  if (current) download(report(current), 'decision-models-report.md', 'text/markdown');
};
element<HTMLInputElement>('reference').onchange = async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('reference_too_large');
    importReference(JSON.parse(await file.text()) as unknown);
  } catch {
    element('reference-status').textContent =
      'Reference rejected: expected the pinned candidate revision and exactly 200 unique, typed id/value answers.';
  }
};
element<HTMLButtonElement>('memory-save').onclick = () => {
  if (!current || (running && !holdingModel)) return;
  const selected = current.arms.find((arm) => arm.id === memoryArm.value);
  if (!selected) return;
  const reading = (id: string): number | null => {
    const input = element<HTMLInputElement>(id);
    return input.value === ''
      ? null
      : input.validity.valid && Number.isFinite(input.valueAsNumber) && input.valueAsNumber >= 0
        ? input.valueAsNumber
        : null;
  };
  const unsupported = element<HTMLInputElement>('memory-unsupported').checked;
  selected.gpuMemory = {
    ...selected.gpuMemory,
    modelAlone: reading('memory-alone'),
    withChatModel: unsupported ? null : reading('memory-chat'),
    status: unsupported
      ? 'unsupported_configuration'
      : reading('memory-alone') !== null || reading('memory-chat') !== null
        ? 'measured'
        : 'not_measured',
  };
  render();
};
async function initialize(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const order = selectedArms(params.get('arms'));
  const parsedRuns = Number(params.get('runs') ?? '5');
  const runs = Number.isSafeInteger(parsedRuns) && parsedRuns >= 1 ? parsedRuns : 5;
  const profile = await deviceProfile();
  const activation = async (create: () => Promise<PromptSession>): Promise<PromptSession> => {
    if (navigator.userActivation.isActive) return create();
    return new Promise((resolve, reject) => {
      status.textContent =
        'Built-in AI requires a fresh activation. Click Run to permit the browser-managed download.';
      run.disabled = false;
      activate = () => {
        activate = null;
        run.disabled = true;
        void create().then(resolve, reject);
      };
    });
  };
  const arms: Arm[] = [
    new MockArm(params.get('mockFail'), params.get('mockConfidence') === 'none'),
    new BuiltinArm(activation),
    new OrtCandidate('watersheep', profile),
    new OrtCandidate('laya', profile),
    new OrtCandidate('d1', profile),
  ];
  current = makeResults(profile, await probeArms(arms, profile), order, runs);
  for (const arm of arms) {
    const option = document.createElement('option');
    option.value = arm.id;
    option.textContent = arm.id;
    memoryArm.append(option);
  }
  element('device').textContent =
    `${profile.userAgent}; WebGPU adapter: ${profile.webgpu.adapter?.description ?? 'unavailable'}. Selected: ${order.join(', ')}.`;
  render();
  run.disabled = false;
  status.textContent =
    'Ready. Mock output is harness evidence only. Run permits selected real-arm downloads.';
  run.onclick = async () => {
    if (activate) {
      activate();
      return;
    }
    if (running) return;
    running = true;
    done = false;
    error = null;
    run.disabled = true;
    resultsButton.disabled = reportButton.disabled = true;
    try {
      const probed = await probeArms(arms, profile);
      for (const result of probed) {
        const previous = current?.arms.find((arm) => arm.id === result.id);
        if (previous) result.gpuMemory = previous.gpuMemory;
      }
      current = makeResults(profile, probed, order, runs);
      observations.clear();
      for (const id of order) {
        const arm = arms.find((arm) => arm.id === id);
        const result = current.arms.find((arm) => arm.id === id);
        if (arm && result) {
          status.textContent = `${id}: ${id === 'mock' ? 'synthetic harness evidence only' : 'device demonstration'}`;
          await runArm(
            arm,
            result,
            {
              runs,
              probeOnly: params.get('probe') === 'real',
              progress: (message) => {
                status.textContent = message;
              },
              beforeDispose: async (loaded) => {
                holdingModel = true;
                memoryArm.value = loaded.id;
                element<HTMLInputElement>('memory-alone').value = '';
                element<HTMLInputElement>('memory-chat').value = '';
                element<HTMLInputElement>('memory-unsupported').checked = false;
                releaseButton.hidden = releaseButton.disabled = false;
                render();
                status.textContent = `${loaded.id}: session loaded; decision metrics UNMEASURED. Record optional OS/Chrome GPU readings, then Release loaded model.`;
                await new Promise<void>((resolve) => {
                  releaseButton.onclick = () => resolve();
                });
                releaseButton.hidden = releaseButton.disabled = true;
                holdingModel = false;
              },
            },
            observations,
          );
        }
      }
      for (const result of current.arms)
        applyReference(result, observations.get(result.id), reference);
      current = resultsSchema.parse(current);
      done = true;
      status.textContent =
        'Finished. Mock numbers are harness evidence only. See the report for every UNMEASURED item.';
    } catch {
      error = 'harness_failed';
      status.textContent = 'Harness failed; no unvalidated export is available.';
    } finally {
      running = false;
      run.disabled = false;
      if (!error) render();
    }
  };
}
void initialize().catch(() => {
  error = 'initialization_failed';
  status.textContent = 'Initialization failed.';
});
