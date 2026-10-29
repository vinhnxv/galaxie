// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type AgentInstance, isGalaxieError, type RunId, type SessionId } from '@galaxie/core';
import {
  lessonFixture,
  ProgressInputSchema,
  type TutorInput,
} from '@galaxie/example-english-tutor';
import { AgentSurface, useAgentSnapshot } from '@galaxie/react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import type { LocalHost, StorageStatus } from './runtime.js';
import { claimSession, sessionKey } from './session.js';

interface AppProps {
  readonly initialHost?: LocalHost;
  readonly prepareModels?: () => Promise<LocalHost>;
}

interface SessionOwnership {
  release(): Promise<void>;
  unsubscribe?: () => void;
}

function Lesson({
  host,
  instance,
  score,
  disabled,
}: {
  readonly host: LocalHost;
  readonly instance: AgentInstance<TutorInput, unknown>;
  readonly score: string | undefined;
  readonly disabled: boolean;
}): ReactElement {
  const snapshot = useAgentSnapshot(instance);
  return (
    <>
      <p role="status">
        Run: {snapshot.run?.status ?? snapshot.state}
        {score ? `; Score: ${score}` : ''}
      </p>
      <fieldset disabled={disabled}>
        <legend>Lesson</legend>
        <AgentSurface instance={instance} registry={host.registry} surfaceId="lesson-main" />
      </fieldset>
    </>
  );
}

export function App({ initialHost, prepareModels }: AppProps): ReactElement {
  const [host, setHost] = useState(initialHost);
  const [instance, setInstance] = useState<AgentInstance<TutorInput, unknown>>();
  const [score, setScore] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(initialHost !== undefined);
  const [blocked, setBlocked] = useState(false);
  const [retryRestore, setRetryRestore] = useState(false);
  const [recoverySession, setRecoverySession] = useState<SessionId>();
  const [storageStatus, setStorageStatus] = useState<StorageStatus>('ready');
  const ownership = useRef<SessionOwnership | undefined>(undefined);
  const starting = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setStorageStatus(host?.getStorageStatus() ?? 'ready');
    return host?.subscribeStorage(() => setStorageStatus(host.getStorageStatus()));
  }, [host]);

  const prepare = async (): Promise<void> => {
    if (busy || host || !prepareModels) return;
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await prepareModels();
      if (mounted.current) {
        setChecking(true);
        setHost(prepared);
      } else await prepared.runtime.dispose();
    } catch {
      if (mounted.current) setError('Model preparation is unavailable. Try preparing again.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const followOutput = useCallback(
    async (next: AgentInstance<TutorInput, unknown>, runId: RunId): Promise<void> => {
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
    },
    [],
  );

  const run = useCallback(
    async (restore: boolean): Promise<void> => {
      if (!host || starting.current || host.getStorageStatus() === 'superseded') return;
      starting.current = true;
      setChecking(true);
      setError(undefined);
      setRetryRestore(false);
      let next: AgentInstance<TutorInput, unknown> | undefined;
      let owner: SessionOwnership | undefined;
      let restoring = false;
      let storedSession: SessionId | undefined;
      const dispose = async (): Promise<void> => {
        owner?.unsubscribe?.();
        await next?.dispose();
        await owner?.release();
        if (ownership.current === owner) ownership.current = undefined;
      };
      try {
        const stored = restore ? sessionStorage.getItem(sessionKey) : null;
        if (restore && stored === null) return;
        restoring = stored !== null;
        storedSession = stored === null ? undefined : (stored as SessionId);
        const release = await claimSession();
        if (release === undefined) {
          if (mounted.current) {
            setBlocked(true);
            setError('The lesson is active in another tab.');
          }
          return;
        }
        owner = { release };
        ownership.current = owner;
        if (!mounted.current) {
          await dispose();
          return;
        }
        next = await host.createInstance(stored === null ? undefined : (stored as SessionId));
        await next.prepare();
        if (!mounted.current) {
          await dispose();
          return;
        }
        const observed = next;
        owner.unsubscribe = next.subscribe(() => {
          const snapshot = observed.getSnapshot();
          // Disposal cancels the in-memory run; its checkpoint must remain restorable on reload.
          if (snapshot.state !== 'ready') return;
          const status = snapshot.run?.status;
          if (status === 'waiting_input') sessionStorage.setItem(sessionKey, observed.sessionId);
          else if (status === 'succeeded') sessionStorage.removeItem(sessionKey);
        });
        const result = restoring
          ? await next.restore()
          : await next.start({ lessonId: lessonFixture.id });
        if (result === undefined) {
          sessionStorage.removeItem(sessionKey);
          await dispose();
          return;
        }
        if (!mounted.current) {
          await dispose();
          return;
        }
        setInstance(next);
        setChecking(false);
        await followOutput(next, result.runId);
      } catch (failure) {
        if (!mounted.current) {
          await dispose();
          return;
        }
        const discard =
          restoring &&
          isGalaxieError(failure) &&
          (failure.code === 'denied' ||
            failure.code === 'unsupported' ||
            failure.code === 'invalid');
        if (discard) sessionStorage.removeItem(sessionKey);
        await dispose();
        if (mounted.current) {
          setInstance(undefined);
          if (!discard) {
            const unrecoverable =
              restoring && isGalaxieError(failure) && failure.code === 'unrecoverable';
            setRecoverySession(unrecoverable ? storedSession : undefined);
            setRetryRestore(restoring && !unrecoverable);
            setError(
              unrecoverable
                ? 'Saved lesson cannot be recovered'
                : restoring
                  ? 'The lesson could not be restored. Try again.'
                  : 'The lesson could not start.',
            );
          }
        }
      } finally {
        starting.current = false;
        if (mounted.current) setChecking(false);
      }
    },
    [host, followOutput],
  );

  const startOver = async (): Promise<void> => {
    if (!host || !recoverySession || starting.current || host.getStorageStatus() === 'superseded')
      return;
    starting.current = true;
    setChecking(true);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await claimSession();
      if (release === undefined) {
        setBlocked(true);
        setError('The lesson is active in another tab.');
        return;
      }
      await host.deleteSession(recoverySession);
      sessionStorage.removeItem(sessionKey);
      if (mounted.current) {
        setRecoverySession(undefined);
        setError(undefined);
        setInstance(undefined);
        setScore(undefined);
      }
    } catch {
      if (mounted.current) setError('Saved lesson cannot be recovered');
    } finally {
      await release?.();
      starting.current = false;
      if (mounted.current) setChecking(false);
    }
  };

  useEffect(() => {
    if (!host) return;
    void run(true);
    const disposeHost = (): void => {
      ownership.current?.unsubscribe?.();
      void host.runtime.dispose().finally(() => ownership.current?.release());
    };
    const discard = (event: PageTransitionEvent): void => {
      if (event.persisted) return;
      mounted.current = false;
      disposeHost();
    };
    window.addEventListener('pagehide', discard);
    return () => {
      window.removeEventListener('pagehide', discard);
      disposeHost();
    };
  }, [host, run]);

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
        disabled={
          !host ||
          instance !== undefined ||
          checking ||
          blocked ||
          retryRestore ||
          recoverySession !== undefined ||
          storageStatus === 'superseded'
        }
        onClick={() => void run(false)}
      >
        Start
      </button>
      {storageStatus === 'superseded' ? <p role="alert">Reload to use the updated app</p> : null}
      {storageStatus === 'quota' ? <p role="alert">Storage is full</p> : null}
      {error && storageStatus !== 'superseded' ? <p role="alert">{error}</p> : null}
      {recoverySession ? (
        <button
          type="button"
          disabled={checking || blocked || storageStatus === 'superseded'}
          onClick={() => void startOver()}
        >
          Start over
        </button>
      ) : null}
      {retryRestore ? (
        <button
          type="button"
          disabled={checking || storageStatus === 'superseded'}
          onClick={() => void run(true)}
        >
          Retry
        </button>
      ) : null}
      {host && instance ? (
        <Lesson
          host={host}
          instance={instance}
          score={score}
          disabled={storageStatus === 'superseded'}
        />
      ) : (
        <p role="status">
          {checking ? 'Restoring lesson…' : host ? 'Ready' : 'Prepare models before starting.'}
        </p>
      )}
    </main>
  );
}
