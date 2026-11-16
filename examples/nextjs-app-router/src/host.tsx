// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentInstance, ModelDescriptor } from '@galaxie-ai/core';
import { AgentSurface, ModelRoutes, type Registry, useAgentSnapshot } from '@galaxie-ai/react';
import { type ReactElement, useEffect, useState } from 'react';

export interface Host<Input> {
  readonly instance: AgentInstance<Input, unknown>;
  readonly registry: Registry;
  dispose(): Promise<void>;
}

export const mockDescriptor: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  languages: ['en'],
  features: ['streaming', 'cancellation'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};

function Question<Input>({
  host,
  readResult,
}: {
  readonly host: Host<Input>;
  readonly readResult: (output: unknown) => string | undefined;
}): ReactElement {
  const snapshot = useAgentSnapshot(host.instance);
  const [result, setResult] = useState<string>();
  useEffect(() => {
    let active = true;
    const runId = snapshot.run?.runId;
    if (runId !== undefined)
      void (async () => {
        for await (const event of host.instance.events(runId)) {
          if (!active) break;
          if (event.type === 'output') setResult(readResult(event.output));
        }
      })();
    return () => {
      active = false;
    };
  }, [host, readResult, snapshot.run?.runId]);
  return (
    <>
      <ModelRoutes
        instance={host.instance}
        labels={{ roles: { comment: 'Comment' }, providers: { mock: 'Mock' } }}
      />
      <AgentSurface instance={host.instance} registry={host.registry} surfaceId="question" />
      {result === undefined ? null : <p role="status">{result}</p>}
      {snapshot.run?.status === 'failed' ? <p role="alert">The mock agent failed.</p> : null}
    </>
  );
}

export function AgentHost<Input>({
  open,
  input,
  readResult,
}: {
  readonly open: () => Promise<Host<Input>>;
  readonly input: Input;
  readonly readResult: (output: unknown) => string | undefined;
}): ReactElement {
  const [host, setHost] = useState<Host<Input>>();
  const [failed, setFailed] = useState(false);
  const [workerReply, setWorkerReply] = useState('Starting worker.');
  useEffect(() => {
    let active = true;
    let current: Host<Input> | undefined;
    const worker = new Worker(new URL('./ping-worker.ts', import.meta.url));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (active && event.data === 'pong') setWorkerReply('Worker: pong');
    };
    worker.onerror = () => {
      if (active) setFailed(true);
    };
    worker.postMessage('ping');
    void (async () => {
      try {
        current = await open();
        if (!active) {
          await current.dispose();
          return;
        }
        await current.instance.prepare();
        if (!active) {
          await current.dispose();
          return;
        }
        await current.instance.start(input);
        if (active) setHost(current);
        else await current.dispose();
      } catch {
        await current?.dispose();
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      worker.terminate();
      void current?.dispose();
    };
  }, [open, input]);
  return (
    <section aria-label="Browser agent">
      <p role="status">{workerReply}</p>
      {failed ? <p role="alert">The browser agent could not start.</p> : null}
      {host === undefined ? null : <Question host={host} readResult={readResult} />}
    </section>
  );
}
