// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { SessionId } from '@galaxie/core';
import { AgentSurface, ModelRoutes, useAgentSnapshot } from '@galaxie/react';
import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react';
import { controlLabels, type ModelState, modelStates } from './model-state.js';
import { sessionKey, type TemplateHost, type TemplateInstance } from './runtime.js';

function ModelStatus({
  state,
  host,
}: {
  readonly state: ModelState;
  readonly host: TemplateHost;
}): ReactElement {
  const entry = modelStates[state];
  const snapshot = host.getModelSnapshot();
  return (
    <section>
      <p role="status">{entry.message}</p>
      {state === 'downloading' ? (
        <progress aria-label="WebLLM download" max={1} value={snapshot.progress} />
      ) : null}
      {entry.control === null ? null : (
        <button
          type="button"
          onClick={() => {
            if (entry.control === 'cancel') host.cancelDownload();
            else if (window.confirm(modelStates.offer.message)) void host.downloadWebLLM();
            else host.declineDownload();
          }}
        >
          {controlLabels[entry.control]}
        </button>
      )}
    </section>
  );
}

function Question({
  host,
  instance,
}: {
  readonly host: TemplateHost;
  readonly instance: TemplateInstance;
}): ReactElement {
  const snapshot = useAgentSnapshot(instance);
  const [result, setResult] = useState<string>();
  useEffect(() => {
    let active = true;
    const runId = snapshot.run?.runId;
    if (runId !== undefined)
      void (async () => {
        for await (const event of instance.events(runId)) {
          if (!active) break;
          if (event.type !== 'output' || typeof event.output !== 'object' || event.output === null)
            continue;
          const value = (event.output as Record<string, unknown>)['result'];
          if (typeof value === 'string') setResult(value);
        }
      })();
    return () => {
      active = false;
    };
  }, [instance, snapshot.run?.runId]);
  return (
    <>
      <ModelRoutes
        instance={instance}
        labels={{
          roles: { comment: 'Comment' },
          providers: { builtin: 'Built-in AI', mock: 'Mock', webllm: 'WebLLM' },
        }}
      />
      <AgentSurface instance={instance} registry={host.registry} surfaceId="question" />
      {result === undefined ? null : <p role="status">{result}</p>}
      {snapshot.run?.status === 'failed' ? (
        <p role="alert">The question could not finish. Reload to restore the saved question.</p>
      ) : null}
    </>
  );
}

export function App({ host }: { readonly host: TemplateHost }): ReactElement {
  const model = useSyncExternalStore(host.subscribeModels, host.getModelSnapshot);
  const [instance, setInstance] = useState<TemplateInstance>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only re-runs the open after a failure.
  useEffect(() => {
    let active = true;
    let next: TemplateInstance | undefined;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const stored = sessionStorage.getItem(sessionKey) as SessionId | null;
        next = await host.createInstance(stored ?? undefined);
        await next.prepare();
        const current = next;
        unsubscribe = current.subscribe(() => {
          if (current.getSnapshot().run?.status === 'waiting_input')
            sessionStorage.setItem(sessionKey, current.sessionId);
          else if (current.getSnapshot().run?.status === 'succeeded')
            sessionStorage.removeItem(sessionKey);
        });
        const started = stored === null ? await current.start({}) : await current.restore();
        if (!active) {
          await current.dispose();
          return;
        }
        if (started === undefined) {
          sessionStorage.removeItem(sessionKey);
          await current.start({});
        }
        setInstance(current);
      } catch {
        await next?.dispose();
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      unsubscribe?.();
      void next?.dispose();
    };
  }, [host, attempt]);
  return (
    <main>
      <h1>Local-only agent</h1>
      <p>
        Active model:{' '}
        {model.route === 'builtin' ? 'Built-in AI' : model.route === 'webllm' ? 'WebLLM' : 'Mock'}.
        Inference stays in this browser.
      </p>
      {model.route === 'mock' && model.builtinReason !== undefined ? (
        <ModelStatus state={model.builtinReason} host={host} />
      ) : null}
      {model.webllm === undefined ? null : <ModelStatus state={model.webllm} host={host} />}
      {failed ? (
        <section>
          <p role="alert">
            The saved question could not open. Close other template tabs and retry.
          </p>
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            Retry
          </button>
        </section>
      ) : null}
      {instance === undefined ? null : <Question host={host} instance={instance} />}
    </main>
  );
}
