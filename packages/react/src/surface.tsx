// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type AgentInstance,
  type DispatchReceipt,
  type ErrorCode,
  type ErrorInfo,
  type PendingInteraction,
  type RunId,
  type SurfaceId,
  toErrorInfo,
  validateSync,
} from '@galaxie/core';
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentSnapshot } from './hooks.js';
import type {
  ActionDefinitions,
  BoundActions,
  ComponentEntry,
  InteractionStatus,
  Registry,
} from './registry.js';

export interface AgentSurfaceProps<Input = unknown, View = unknown> {
  readonly instance: AgentInstance<Input, View>;
  readonly registry: Registry;
  readonly surfaceId: SurfaceId;
  readonly fallback?: (error: ErrorInfo) => ReactNode;
  readonly onError?: (error: ErrorInfo) => void;
}

function rejected(code: ErrorCode): DispatchReceipt {
  return { status: 'rejected', error: toErrorInfo(code) };
}

function RejectedInteraction({
  error,
  fallback,
  onError,
}: {
  readonly error: ErrorInfo;
  readonly fallback: AgentSurfaceProps['fallback'];
  readonly onError: AgentSurfaceProps['onError'];
}): ReactElement | null {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || onError === undefined) return;
    reported.current = true;
    onError(error);
  }, [error, onError]);
  return fallback === undefined ? null : <>{fallback(error)}</>;
}

function RenderedInteraction<Input, View>({
  instance,
  runId,
  pending,
  entry,
  props,
}: {
  readonly instance: AgentInstance<Input, View>;
  readonly runId: RunId;
  readonly pending: PendingInteraction;
  readonly entry: ComponentEntry;
  readonly props: unknown;
}): ReactElement | null {
  const [status, setStatus] = useState<InteractionStatus>('idle');
  const guard = useRef<'idle' | 'submitting' | 'accepted'>('idle');
  const actions = useMemo<BoundActions<ActionDefinitions>>(
    () =>
      Object.fromEntries(
        Object.entries(entry.actions).map(([name, action]) => [
          name,
          {
            label: action.label,
            async submit(payload: unknown): Promise<DispatchReceipt> {
              // A prior run's action must still reach core with its captured identity.
              if (instance.getSnapshot().run?.runId === runId && guard.current !== 'idle')
                return rejected('duplicate');
              if (!validateSync(action.payload, payload).ok) {
                setStatus({ rejected: 'invalid' });
                return rejected('invalid');
              }
              guard.current = 'submitting';
              setStatus('submitting');
              let receipt: DispatchReceipt;
              try {
                receipt = await instance.dispatch({
                  instanceId: instance.instanceId,
                  runId,
                  interactionId: pending.interactionId,
                  surfaceId: pending.surfaceId,
                  viewRevision: pending.viewRevision,
                  action: name,
                  payload,
                });
              } catch {
                receipt = rejected('executor_error');
              }
              guard.current = receipt.status === 'accepted' ? 'accepted' : 'idle';
              setStatus(
                receipt.status === 'accepted' ? 'accepted' : { rejected: receipt.error.code },
              );
              return receipt;
            },
          },
        ]),
      ),
    [entry, instance, pending, runId],
  );
  const Component = entry.component;
  return <Component props={props} actions={actions} status={status} />;
}

/** Renders only a validated interaction on the host-assigned surface. */
export function AgentSurface<Input, View>({
  instance,
  registry,
  surfaceId,
  fallback,
  onError,
}: AgentSurfaceProps<Input, View>): ReactElement | null {
  const snapshot = useAgentSnapshot(instance);
  const run = snapshot.run;
  const pending = run?.pending?.surfaceId === surfaceId ? run.pending : undefined;
  const resolved = useMemo(
    () => (pending === undefined ? undefined : registry.resolve(pending)),
    [pending, registry],
  );
  if (pending === undefined || run === undefined || resolved === undefined) return null;
  const key = JSON.stringify([
    snapshot.instanceId,
    run.runId,
    pending.interactionId,
    pending.viewRevision,
  ]);
  if (!resolved.ok)
    return (
      <RejectedInteraction key={key} error={resolved.error} fallback={fallback} onError={onError} />
    );
  return (
    <RenderedInteraction
      key={key}
      instance={instance}
      runId={run.runId}
      pending={pending}
      entry={resolved.entry}
      props={resolved.props}
    />
  );
}
