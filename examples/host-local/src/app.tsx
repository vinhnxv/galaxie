// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { AgentInstance } from '@galaxie/core';
import {
  lessonFixture,
  ProgressInputSchema,
  type TutorInput,
} from '@galaxie/example-english-tutor';
import { AgentSurface, useAgentSnapshot } from '@galaxie/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { LocalHost } from './runtime.js';

interface AppProps {
  readonly initialHost?: LocalHost;
  readonly prepareModels?: () => Promise<LocalHost>;
}

function Lesson({
  host,
  instance,
  score,
}: {
  readonly host: LocalHost;
  readonly instance: AgentInstance<TutorInput, unknown>;
  readonly score: string | undefined;
}): ReactElement {
  const snapshot = useAgentSnapshot(instance);
  return (
    <>
      <p role="status">
        Run: {snapshot.run?.status ?? snapshot.state}
        {score ? `; Score: ${score}` : ''}
      </p>
      <AgentSurface instance={instance} registry={host.registry} surfaceId="lesson-main" />
    </>
  );
}

export function App({ initialHost, prepareModels }: AppProps): ReactElement {
  const [host, setHost] = useState(initialHost);
  const [instance, setInstance] = useState<AgentInstance<TutorInput, unknown>>();
  const [score, setScore] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const starting = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      void host?.runtime.dispose();
    },
    [host],
  );

  const prepare = async (): Promise<void> => {
    if (busy || host || !prepareModels) return;
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await prepareModels();
      if (mounted.current) setHost(prepared);
      else await prepared.runtime.dispose();
    } catch {
      if (mounted.current) setError('Model preparation is unavailable. Try preparing again.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (!host || starting.current) return;
    starting.current = true;
    setError(undefined);
    let next: AgentInstance<TutorInput, unknown> | undefined;
    try {
      next = await host.createInstance();
      await next.prepare();
      if (!mounted.current) {
        await next.dispose();
        return;
      }
      setInstance(next);
      const { runId } = await next.start({ lessonId: lessonFixture.id });
      for await (const event of next.events(runId)) {
        if (!mounted.current) break;
        if (event.type !== 'output' || typeof event.output !== 'object' || event.output === null)
          continue;
        const output = event.output as Record<string, unknown>;
        const parsed = ProgressInputSchema.safeParse({
          lessonId: output['lessonId'],
          score: output['score'],
          total: output['total'],
        });
        if (parsed.success) setScore(`${parsed.data.score}/${parsed.data.total}`);
      }
    } catch {
      await next?.dispose();
      starting.current = false;
      if (mounted.current) {
        setInstance(undefined);
        setError('The lesson could not start.');
      }
    }
  };

  return (
    <main>
      <h1>Local English tutor</h1>
      <p>
        Practice only. Model-generated content is shown as text. Both model roles run in your
        browser.
      </p>
      {prepareModels ? (
        <>
          <p>
            Prepare models may download 868,547,584 weight bytes for WebLLM. The browser manages the
            Built-in AI download and does not report its size.
          </p>
          <button
            type="button"
            disabled={busy || host !== undefined}
            onClick={() => void prepare()}
          >
            {busy ? 'Preparing models…' : 'Prepare models'}
          </button>
        </>
      ) : null}
      <button
        type="button"
        disabled={!host || instance !== undefined || starting.current}
        onClick={() => void start()}
      >
        Start
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {host && instance ? (
        <Lesson host={host} instance={instance} score={score} />
      ) : (
        <p role="status">{host ? 'Ready' : 'Prepare models before starting.'}</p>
      )}
    </main>
  );
}
