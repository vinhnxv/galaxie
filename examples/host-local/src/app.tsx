// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type AgentInstance, isGalaxieError, type RunId, type SessionId } from '@galaxie-ai/core';
import {
  type InvalidationWatcher,
  type Ownership,
  watchInvalidation,
} from '@galaxie-ai/core/browser';
import {
  lessonFixture,
  ProgressInputSchema,
  type TutorInput,
} from '@galaxie-ai/example-english-tutor';
import { AgentSurface, ModelRoutes, useAgentSnapshot } from '@galaxie-ai/react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import type { LocalHost, StorageStatus } from './runtime.js';
import {
  downloadSession,
  hostAppId,
  hostLearnerId,
  invalidateLocalPrincipal,
  sessionKey,
} from './session.js';

interface AppProps {
  readonly initialHost?: LocalHost;
  readonly prepareModels?: () => Promise<LocalHost>;
}

interface SessionOwnership {
  readonly handle: Ownership;
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
      <ModelRoutes
        instance={instance}
        labels={{
          roles: { 'quiz.generate': 'Quiz', 'tutor.feedback': 'Feedback' },
          providers: {
            builtin: 'Chrome Built-in AI',
            webllm: 'WebLLM',
            quiz: 'Mock quiz',
            review: 'Mock review',
          },
        }}
      />
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
  const [moved, setMoved] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [confirmExport, setConfirmExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const signingOutRef = useRef(false);
  const signedOutRef = useRef(false);
  const signOutDisposal = useRef<Promise<void> | undefined>(undefined);
  const watcher = useRef<InvalidationWatcher | undefined>(undefined);
  const currentHost = useRef(host);
  const currentInstance = useRef(instance);
  currentHost.current = host;
  currentInstance.current = instance;
  const lost = useRef(false);
  const [retryRestore, setRetryRestore] = useState(false);
  const [recoverySession, setRecoverySession] = useState<SessionId>();
  const [storageStatus, setStorageStatus] = useState<StorageStatus>('ready');
  const ownership = useRef<SessionOwnership | undefined>(undefined);
  const starting = useRef(false);
  const mounted = useRef(true);
  const canExport =
    host !== undefined &&
    instance !== undefined &&
    ownership.current !== undefined &&
    !ownership.current.handle.signal.aborted &&
    !signedOut &&
    !signingOut &&
    !moved &&
    !blocked &&
    !checking &&
    storageStatus !== 'superseded';

  const exportSession = async (personalContent = false): Promise<void> => {
    if (!host || !instance || !canExport || exporting) return;
    const owner = ownership.current;
    const stillCurrent = (): boolean =>
      mounted.current &&
      !lost.current &&
      !signingOutRef.current &&
      !signedOutRef.current &&
      owner === ownership.current &&
      owner !== undefined &&
      !owner.handle.signal.aborted &&
      currentInstance.current === instance &&
      host.getStorageStatus() !== 'superseded';
    if (!stillCurrent()) return;
    setConfirmExport(false);
    setExportFailed(false);
    setExporting(true);
    try {
      const exported = personalContent
        ? await host.exportSession(instance.sessionId, { personalContent: true })
        : await host.exportSession(instance.sessionId);
      if (stillCurrent()) downloadSession(exported);
    } catch {
      if (stillCurrent()) setExportFailed(true);
    } finally {
      if (mounted.current) setExporting(false);
    }
  };

  const finishSignOut = useCallback((): Promise<void> => {
    if (signedOutRef.current) return signOutDisposal.current ?? Promise.resolve();
    signedOutRef.current = true;
    lost.current = true;
    sessionStorage.removeItem(sessionKey);
    const owner = ownership.current;
    owner?.unsubscribe?.();
    if (mounted.current) {
      setSignedOut(true);
      setMoved(false);
      setError(undefined);
      setSignOutFailed(false);
      setConfirmExport(false);
      setExportFailed(false);
      setChecking(false);
      setRetryRestore(false);
      setRecoverySession(undefined);
      setInstance(undefined);
      setScore(undefined);
    }
    signOutDisposal.current = (async () => {
      try {
        await currentInstance.current?.dispose();
        await currentHost.current?.runtime.dispose();
      } finally {
        await owner?.handle.release();
        if (ownership.current === owner) ownership.current = undefined;
      }
    })();
    return signOutDisposal.current;
  }, []);

  useEffect(() => {
    const next = watchInvalidation({ appId: hostAppId, principalScope: hostLearnerId });
    watcher.current = next;
    const invalidate = (): void => {
      void finishSignOut().catch(() => {});
    };
    next.signal.addEventListener('abort', invalidate, { once: true });
    return () => {
      next.signal.removeEventListener('abort', invalidate);
      next.close();
      if (watcher.current === next) watcher.current = undefined;
    };
  }, [finishSignOut]);

  const signOut = async (): Promise<void> => {
    if (signingOutRef.current || signedOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      if (currentHost.current) await currentHost.current.signOut();
      else await invalidateLocalPrincipal();
      watcher.current?.announce();
      await finishSignOut();
    } catch {
      if (mounted.current && !signedOutRef.current) setSignOutFailed(true);
    } finally {
      signingOutRef.current = false;
      if (mounted.current) setSigningOut(false);
    }
  };

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
    if (lost.current || signingOutRef.current || busy || host || !prepareModels) return;
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await prepareModels();
      if (mounted.current && !lost.current) {
        setChecking(true);
        setHost(prepared);
      } else await prepared.runtime.dispose();
    } catch {
      if (mounted.current && !lost.current)
        setError('Model preparation is unavailable. Try preparing again.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const followOutput = useCallback(
    async (next: AgentInstance<TutorInput, unknown>, runId: RunId): Promise<void> => {
      for await (const event of next.events(runId)) {
        if (!mounted.current || lost.current) break;
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

  const observeOwnership = useCallback(
    (handle: Ownership): SessionOwnership => {
      const owner: SessionOwnership = { handle };
      ownership.current = owner;
      const onLoss = (): void => {
        if (handle.lostReason === 'released') return;
        lost.current = true;
        owner.unsubscribe?.();
        if (mounted.current) {
          setMoved(true);
          setConfirmExport(false);
          setBlocked(true);
          setRetryRestore(false);
          setChecking(false);
        }
        void host?.runtime.dispose().catch(() => {});
      };
      handle.signal.addEventListener('abort', onLoss, { once: true });
      if (handle.signal.aborted) onLoss();
      return owner;
    },
    [host],
  );

  const run = useCallback(
    async (restore: boolean, takeover = false): Promise<void> => {
      if (
        !host ||
        lost.current ||
        signingOutRef.current ||
        starting.current ||
        host.getStorageStatus() === 'superseded'
      )
        return;
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
        await owner?.handle.release();
        if (ownership.current === owner) ownership.current = undefined;
      };
      try {
        const stored = restore ? sessionStorage.getItem(sessionKey) : null;
        if (restore && stored === null) return;
        restoring = stored !== null;
        storedSession = stored === null ? undefined : (stored as SessionId);
        const acquired = await host.acquireOwnership(takeover);
        if (acquired.status === 'busy') {
          if (mounted.current) {
            setBlocked(true);
            setError('The lesson is active in another tab.');
          }
          return;
        }
        owner = observeOwnership(acquired.ownership);
        if (!lost.current) setBlocked(false);
        if (!mounted.current || lost.current) {
          await dispose();
          return;
        }
        next = await host.createInstance(stored === null ? undefined : (stored as SessionId));
        if (!mounted.current || lost.current) {
          await dispose();
          return;
        }
        await next.prepare();
        if (!mounted.current || lost.current) {
          await dispose();
          return;
        }
        const observed = next;
        owner.unsubscribe = next.subscribe(() => {
          const snapshot = observed.getSnapshot();
          // Disposal cancels the in-memory run; its checkpoint must remain restorable on reload.
          if (lost.current || owner?.handle.signal.aborted || snapshot.state !== 'ready') return;
          const status = snapshot.run?.status;
          if (status === 'waiting_input') sessionStorage.setItem(sessionKey, observed.sessionId);
          else if (status === 'succeeded') sessionStorage.removeItem(sessionKey);
        });
        const result = restoring
          ? await next.restore()
          : await next.start({ lessonId: lessonFixture.id });
        if (!mounted.current || lost.current) {
          await dispose();
          return;
        }
        if (result === undefined) {
          sessionStorage.removeItem(sessionKey);
          await dispose();
          return;
        }
        setInstance(next);
        setChecking(false);
        await followOutput(next, result.runId);
      } catch (failure) {
        if (!mounted.current || lost.current) {
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
        if (mounted.current && !lost.current) {
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
    [host, followOutput, observeOwnership],
  );

  const startOver = async (takeover = false): Promise<void> => {
    if (
      !host ||
      lost.current ||
      signingOutRef.current ||
      !recoverySession ||
      starting.current ||
      host.getStorageStatus() === 'superseded'
    )
      return;
    starting.current = true;
    setChecking(true);
    let owner: SessionOwnership | undefined;
    try {
      const acquired = await host.acquireOwnership(takeover);
      if (acquired.status === 'busy') {
        setBlocked(true);
        setError('The lesson is active in another tab.');
        return;
      }
      owner = observeOwnership(acquired.ownership);
      if (!mounted.current || lost.current) return;
      setBlocked(false);
      await host.deleteSession(recoverySession);
      if (!mounted.current || lost.current) return;
      sessionStorage.removeItem(sessionKey);
      if (mounted.current) {
        setRecoverySession(undefined);
        setError(undefined);
        setInstance(undefined);
        setScore(undefined);
      }
    } catch {
      if (mounted.current && !lost.current) setError('Saved lesson cannot be recovered');
    } finally {
      await owner?.handle.release();
      if (ownership.current === owner) ownership.current = undefined;
      starting.current = false;
      if (mounted.current) setChecking(false);
    }
  };

  useEffect(() => {
    if (!host) return;
    void run(true);
    const disposeHost = (): void => {
      ownership.current?.unsubscribe?.();
      void host.runtime.dispose().finally(() => ownership.current?.handle.release());
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
            disabled={signedOut || signingOut || moved || busy || host !== undefined}
            onClick={() => void prepare()}
          >
            {busy ? 'Preparing models…' : 'Prepare models'}
          </button>
        </>
      ) : null}
      <button
        type="button"
        disabled={
          signedOut ||
          signingOut ||
          moved ||
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
      <button type="button" disabled={signedOut || signingOut} onClick={() => void signOut()}>
        Sign out
      </button>
      <button type="button" disabled={!canExport || exporting} onClick={() => void exportSession()}>
        Export session summary
      </button>
      <button
        type="button"
        disabled={!canExport || exporting}
        onClick={() => {
          setExportFailed(false);
          setConfirmExport(true);
        }}
      >
        Export my answers
      </button>
      {confirmExport && canExport ? (
        <fieldset>
          <legend>Export my answers</legend>
          <p>This file contains your answers and lesson text. Keep it private.</p>
          <button type="button" disabled={exporting} onClick={() => void exportSession(true)}>
            Download
          </button>
          <button type="button" onClick={() => setConfirmExport(false)}>
            Cancel
          </button>
        </fieldset>
      ) : null}
      {exportFailed && canExport ? <p role="alert">Export failed</p> : null}
      {signedOut ? <p role="status">Signed out. Reload to continue.</p> : null}
      {signOutFailed && !signedOut ? <p role="alert">Sign out failed</p> : null}
      {moved && !signedOut ? <p role="alert">The lesson moved to another tab.</p> : null}
      {storageStatus === 'superseded' && !signedOut ? (
        <p role="alert">Reload to use the updated app</p>
      ) : null}
      {storageStatus === 'quota' && !signedOut ? <p role="alert">Storage is full</p> : null}
      {error && !moved && storageStatus !== 'superseded' ? <p role="alert">{error}</p> : null}
      {blocked && !moved && !signedOut ? (
        <button
          type="button"
          disabled={signingOut || moved || checking || storageStatus === 'superseded'}
          onClick={() =>
            void (recoverySession
              ? startOver(true)
              : run(sessionStorage.getItem(sessionKey) !== null, true))
          }
        >
          Use here
        </button>
      ) : null}
      {recoverySession && !signedOut ? (
        <button
          type="button"
          disabled={signingOut || moved || checking || blocked || storageStatus === 'superseded'}
          onClick={() => void startOver()}
        >
          Start over
        </button>
      ) : null}
      {retryRestore && !signedOut ? (
        <button
          type="button"
          disabled={signingOut || moved || checking || storageStatus === 'superseded'}
          onClick={() => void run(true)}
        >
          Retry
        </button>
      ) : null}
      {!signedOut && host && instance ? (
        <Lesson
          host={host}
          instance={instance}
          score={score}
          disabled={signingOut || moved || storageStatus === 'superseded'}
        />
      ) : signedOut ? null : (
        <p role="status">
          {checking ? 'Restoring lesson…' : host ? 'Ready' : 'Prepare models before starting.'}
        </p>
      )}
    </main>
  );
}
