// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { AgentSurface, ModelRoutes, useAgentSnapshot } from '@galaxie/react';
import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react';
import { type GatewayState, gatewayStates } from './gateway-state.js';
import type { HybridHost, HybridInstance } from './runtime.js';

export function GatewayStatus({
  state,
  retry,
}: {
  readonly state: GatewayState;
  readonly retry: () => void;
}): ReactElement {
  const entry = gatewayStates[state];
  return (
    <section aria-label="Gateway status">
      <p role="status">{entry.message}</p>
      {entry.control === null ? null : (
        <button type="button" onClick={retry}>
          Retry
        </button>
      )}
    </section>
  );
}

function Question({
  host,
  instance,
}: {
  readonly host: HybridHost;
  readonly instance: HybridInstance;
}): ReactElement {
  const snapshot = useAgentSnapshot(instance);
  const [result, setResult] = useState<string>();
  useEffect(() => {
    let active = true;
    const runId = snapshot.run?.runId;
    if (runId !== undefined) {
      void (async () => {
        for await (const event of instance.events(runId)) {
          if (!active) break;
          if (event.type !== 'output' || typeof event.output !== 'object' || event.output === null)
            continue;
          const value = (event.output as Record<string, unknown>)['result'];
          if (typeof value === 'string') setResult(value);
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [instance, snapshot.run?.runId]);
  return (
    <>
      <ModelRoutes
        instance={instance}
        labels={{ roles: { comment: 'Comment' }, providers: { gateway: 'Gateway' } }}
      />
      <AgentSurface instance={instance} registry={host.registry} surfaceId="question" />
      {result === undefined ? null : <p role="status">{result}</p>}
    </>
  );
}

export function App({ host }: { readonly host: HybridHost }): ReactElement {
  const state = useSyncExternalStore(host.subscribeGateway, host.getGatewayState);
  const [instance, setInstance] = useState<HybridInstance>();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attempt === 0) return;
    let active = true;
    let next: HybridInstance | undefined;
    setInstance(undefined);
    setFailed(false);
    void (async () => {
      try {
        next = await host.createInstance();
        await next.prepare();
        await next.start({});
        if (active) setInstance(next);
        else await next.dispose();
      } catch {
        await next?.dispose();
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      void next?.dispose();
    };
  }, [host, attempt]);
  const retry = (): void => {
    host.resetSession();
    setAttempt((previous) => previous + 1);
  };
  return (
    <main>
      <h1>Hybrid gateway agent</h1>
      <p>
        The agent runs in this browser. The comment uses this site's gateway and its configured
        model server.
      </p>
      <GatewayStatus state={failed ? 'unavailable' : state} retry={retry} />
      {attempt === 0 ? (
        <>
          <p>
            Starting allows this practice request to use the gateway. Reload starts a new question.
          </p>
          <button type="button" onClick={retry}>
            Start with gateway
          </button>
        </>
      ) : null}
      {instance === undefined ? null : (
        <Question key={instance.instanceId} host={host} instance={instance} />
      )}
    </main>
  );
}
