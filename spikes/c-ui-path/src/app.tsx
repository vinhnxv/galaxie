// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  type PendingInteraction,
  type RunEvent,
  type UserInteractionEvent,
} from '@galaxie/core';
import { type ReactElement, useSyncExternalStore } from 'react';
import { definition, GENERATION_KEY, quizGraph } from './graph.js';
import { renderInteraction, submit } from './registry.js';
import { restoreAdapter } from './restore-adapter.js';
import { SAVER_KEY, SessionSaver, THREAD_KEY } from './session-saver.js';
import { Surface } from './surface.js';

const restored = sessionStorage.getItem(THREAD_KEY) !== null;
const urlVariant = location.search.includes('variant=url');
const saver = new SessionSaver();
const runtime = createRuntime({
  appId: 'spike-c',
  executors: [restoreAdapter()],
  urlAllowlist: urlVariant && !restored ? ['https://evil.example'] : [],
});
export const instance = await runtime.create(definition, {
  principalScope: 'spike-c',
  agent: quizGraph(urlVariant),
  services: { chatModels: {}, checkpointer: saver },
});
const singleCopy = (await fetch('/__single-copy').then((response) => response.json())) as {
  ok: boolean;
};
let score: number | undefined;
let probe: PendingInteraction | undefined;
let actionError: string | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
let version = 0;
function notify(): void {
  version++;
  for (const listener of listeners) listener();
}
const snapshots: unknown[] = [];
const events: RunEvent[] = [];
instance.subscribe(() => {
  snapshots.push(instance.getSnapshot());
});
await instance.prepare();
const { runId } = await instance.start(restored ? { restore: true } : { topic: 'English' });
void (async () => {
  for await (const event of instance.events(runId)) {
    if (event.type !== 'stream') events.push(event);
    if (
      event.type === 'output' &&
      typeof event.output === 'object' &&
      event.output !== null &&
      'score' in event.output &&
      typeof event.output.score === 'number'
    ) {
      score = event.output.score;
      notify();
    }
  }
})();

export type SpikeHandle = {
  snapshot: typeof instance.getSnapshot;
  dispatch: (event: UserInteractionEvent) => ReturnType<typeof instance.dispatch>;
  submit: (action: string, payload: unknown) => ReturnType<typeof submit>;
  renderProbe: (pending: PendingInteraction) => string;
  counters: () => { generationRuns: number; checkpointCount: number; dispatches: number };
  singleCopy: () => Promise<{ ok: boolean; resolutions: [string, string][] }>;
  exposure: () => string;
};
declare global {
  interface Window {
    spikeC: SpikeHandle;
  }
}
let dispatches = 0;
const rawDispatch = instance.dispatch.bind(instance);
instance.dispatch = (event) => {
  dispatches++;
  return rawDispatch(event);
};
if (import.meta.env.DEV)
  window.spikeC = {
    snapshot: instance.getSnapshot,
    dispatch: (event) => instance.dispatch(event),
    submit: (action, payload) => {
      const pending = instance.getSnapshot().run?.pending;
      if (!pending) throw new Error('No pending interaction.');
      return submit(instance, pending, action, payload).then((receipt) => {
        if (receipt.status === 'rejected') {
          actionError = receipt.error.code;
          notify();
        }
        return receipt;
      });
    },
    renderProbe: (pending) => {
      probe = pending;
      notify();
      const result = renderInteraction(instance, pending);
      return result.ok ? 'ok' : result.error.code;
    },
    counters: () => ({
      generationRuns: Number(sessionStorage.getItem(GENERATION_KEY) ?? 0),
      checkpointCount: saver.checkpointCount(),
      dispatches,
    }),
    singleCopy: () => fetch('/__single-copy').then((response) => response.json()),
    exposure: () => JSON.stringify({ snapshots, events }),
  };

export function App(): ReactElement {
  useSyncExternalStore(subscribe, () => version);
  const snapshot = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  const rendered = probe && renderInteraction(instance, probe);
  return (
    <main
      style={{
        fontFamily: 'system-ui',
        maxWidth: 740,
        margin: '16px auto',
        padding: 8,
        overflowWrap: 'anywhere',
      }}
    >
      <h1>Spike C: UI path</h1>
      <p data-testid="mode">{restored ? 'Restored' : 'Fresh'}</p>
      <p>
        Run: <span data-testid="run-id">{snapshot.run?.runId}</span>
      </p>
      <p data-testid="single-copy">Single copy: {singleCopy.ok ? 'passed' : 'failed'}</p>
      <Surface instance={instance} score={score} />
      <section data-testid="probe">
        {rendered &&
          (rendered.ok ? (
            rendered.element
          ) : (
            <p data-testid="probe-error" data-code={rendered.error.code}>
              {rendered.error.message}
            </p>
          ))}
      </section>
      {actionError && (
        <p data-testid="action-error" data-code={actionError}>
          {actionError}
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          for (const key of [SAVER_KEY, THREAD_KEY, GENERATION_KEY]) sessionStorage.removeItem(key);
          location.reload();
        }}
      >
        Reset
      </button>
    </main>
  );
}
