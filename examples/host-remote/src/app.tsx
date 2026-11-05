// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentInstance, ModelConsentRequest } from '@galaxie/core';
import { lessonFixture, type TutorInput } from '@galaxie/example-english-tutor';
import { AgentSurface, ConfirmationPrompt, ModelRoutes, useAgentSnapshot } from '@galaxie/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { createRemoteHost, type RemoteHost } from './runtime.js';

function Lesson({
  host,
  instance,
  startOver,
}: {
  readonly host: RemoteHost;
  readonly instance: AgentInstance<TutorInput, unknown>;
  readonly startOver: () => void;
}): ReactElement {
  const snapshot = useAgentSnapshot(instance);
  const failed = snapshot.run?.status === 'failed';
  const message =
    snapshot.run?.error?.code === 'denied'
      ? snapshot.routes?.['tutor.feedback']
        ? 'Progress was not saved.'
        : 'The quiz needs the quiz service.'
      : 'The lesson could not finish.';
  return (
    <>
      <p role="status">Run: {snapshot.run?.status ?? 'starting'}</p>
      <ModelRoutes
        instance={instance}
        labels={{
          roles: { 'quiz.generate': 'Quiz', 'tutor.feedback': 'Feedback' },
          providers: { quiz: 'Site quiz service', feedback: 'Browser feedback' },
        }}
      />
      {failed ? (
        <>
          <p role="alert">{message}</p>
          <button type="button" onClick={startOver}>
            Start over
          </button>
        </>
      ) : (
        <>
          <AgentSurface instance={instance} registry={host.registry} surfaceId="lesson-main" />
          <ConfirmationPrompt instance={instance} confirmations={host.confirmations} />
          {snapshot.run?.status === 'succeeded' && (
            <button type="button" onClick={startOver}>
              Start over
            </button>
          )}
        </>
      )}
    </>
  );
}

export function App(): ReactElement {
  const [active, setActive] = useState<{
    host: RemoteHost;
    instance: AgentInstance<TutorInput, unknown>;
  }>();
  const [decision, setDecision] = useState<{ respond: (allow: boolean) => void }>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const busy = useRef(false);
  const current = useRef<RemoteHost | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    const dispose = (): void => {
      void current.current?.runtime.dispose().catch(() => {});
    };
    const restorePage = (event: PageTransitionEvent): void => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pagehide', dispose);
    window.addEventListener('pageshow', restorePage);
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', dispose);
      window.removeEventListener('pageshow', restorePage);
      dispose();
    };
  }, []);

  const consent = ({ signal }: ModelConsentRequest): Promise<boolean> =>
    new Promise((resolve) => {
      const respond = (allow: boolean): void => {
        signal.removeEventListener('abort', abort);
        if (mounted.current) setDecision(undefined);
        resolve(allow);
      };
      const abort = (): void => respond(false);
      if (signal.aborted) {
        resolve(false);
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      setDecision({ respond });
    });

  const start = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setStarting(true);
    setError(undefined);
    let host: RemoteHost | undefined;
    try {
      host = await createRemoteHost(consent);
      current.current = host;
      const instance = await host.createInstance();
      await instance.prepare();
      if (!mounted.current) {
        await host.runtime.dispose();
        return;
      }
      setActive({ host, instance });
      await instance.start(
        { lessonId: lessonFixture.id },
        { grants: ['lessons.get@1', 'progress.save@1'] },
      );
    } catch {
      await host?.runtime.dispose();
      if (mounted.current) {
        setActive(undefined);
        setError(
          host ? 'The lesson could not start.' : 'This host needs Chrome Built-in AI for feedback.',
        );
      }
    } finally {
      busy.current = false;
      if (mounted.current) setStarting(false);
    }
  };
  const startOver = (): void => {
    void current.current?.runtime.dispose().catch(() => {});
    current.current = undefined;
    setActive(undefined);
    setDecision(undefined);
    setError(undefined);
  };
  return (
    <main>
      <h1>Remote quiz English tutor</h1>
      <p>The quiz uses this site's service. Your sentence feedback stays in this browser.</p>
      {active ? (
        <Lesson host={active.host} instance={active.instance} startOver={startOver} />
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            disabled={starting}
            onClick={() => {
              void start();
            }}
          >
            Start
          </button>
        </>
      )}
      {decision && (
        <fieldset>
          <legend>Send the lesson text to this site's quiz service?</legend>
          <button type="button" onClick={() => decision.respond(true)}>
            Allow
          </button>
          <button type="button" onClick={() => decision.respond(false)}>
            Don't allow
          </button>
        </fieldset>
      )}
    </main>
  );
}
