// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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
import {
  Component,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAlertFocus } from './components/alert-focus.js';
import { useAgentSnapshot } from './hooks.js';
import type {
  ActionDefinitions,
  BoundActions,
  ComponentEntry,
  InteractionStatus,
  Registry,
} from './registry.js';

export interface AgentSurfaceControls {
  /** Cancels this run; a rejected cancel is returned to the host. */
  cancel(): Promise<void>;
}

export interface AgentSurfaceProps<Input = unknown, View = unknown> {
  readonly instance: AgentInstance<Input, View>;
  readonly registry: Registry;
  readonly surfaceId: SurfaceId;
  readonly fallback?: (error: ErrorInfo, controls: AgentSurfaceControls) => ReactNode;
  readonly onError?: (error: ErrorInfo) => void;
}

interface InteractionIdentity<Input, View> {
  readonly instance: AgentInstance<Input, View>;
  readonly runId: RunId;
  readonly pending: PendingInteraction;
}

function DefaultRenderAlert(): ReactElement {
  const alert = useAlertFocus(true, true);
  return (
    <p role="alert" tabIndex={-1} ref={alert}>
      This step could not be shown.
    </p>
  );
}

function failureView(
  error: ErrorInfo,
  fallback: AgentSurfaceProps['fallback'],
  controls: AgentSurfaceControls,
): ReactNode {
  return fallback === undefined ? <DefaultRenderAlert /> : fallback(error, controls);
}

function cancelControls<Input, View>(
  instance: AgentInstance<Input, View>,
  runId: RunId,
): AgentSurfaceControls {
  return {
    async cancel(): Promise<void> {
      await instance.cancel(runId);
    },
  };
}

class RenderBoundary extends Component<{
  readonly children: ReactNode;
  readonly failed: () => void;
  readonly fallback: AgentSurfaceProps['fallback'];
  readonly controls: AgentSurfaceControls;
}> {
  override state: { readonly failed: boolean } = { failed: false };
  private reported: boolean = false;

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    if (this.reported) return;
    this.reported = true;
    this.props.failed();
  }

  override render(): ReactNode {
    return this.state.failed
      ? failureView(toErrorInfo('render_failed'), this.props.fallback, this.props.controls)
      : this.props.children;
  }
}

function RenderCommit<Input, View>({
  instance,
  runId,
  pending,
  children,
}: InteractionIdentity<Input, View> & { readonly children: ReactNode }): ReactNode {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    instance.recordRenderOutcome({
      runId,
      interactionId: pending.interactionId,
      viewRevision: pending.viewRevision,
      status: 'rendered',
    });
  }, [instance, runId, pending]);
  return children;
}

function rejected(code: ErrorCode): DispatchReceipt {
  return { status: 'rejected', error: toErrorInfo(code) };
}

function RejectedInteraction<Input, View>({
  instance,
  runId,
  pending,
  error,
  fallback,
  onError,
}: InteractionIdentity<Input, View> & {
  readonly error: ErrorInfo;
  readonly fallback: AgentSurfaceProps['fallback'];
  readonly onError: AgentSurfaceProps['onError'];
}): ReactElement | null {
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    instance.recordRenderOutcome({
      runId,
      interactionId: pending.interactionId,
      viewRevision: pending.viewRevision,
      status: 'failed',
      code: error.code,
    });
    onError?.(error);
  }, [error, onError, instance, runId, pending]);
  return <>{failureView(error, fallback, cancelControls(instance, runId))}</>;
}

function RenderedInteraction<Input, View>({
  instance,
  runId,
  pending,
  entry,
  props,
  fallback,
  onError,
}: InteractionIdentity<Input, View> & {
  readonly entry: ComponentEntry;
  readonly props: unknown;
  readonly fallback: AgentSurfaceProps['fallback'];
  readonly onError: AgentSurfaceProps['onError'];
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
  const RegisteredComponent = entry.component;
  return (
    <RenderBoundary
      fallback={fallback}
      controls={cancelControls(instance, runId)}
      failed={() => {
        instance.recordRenderOutcome({
          runId,
          interactionId: pending.interactionId,
          viewRevision: pending.viewRevision,
          status: 'failed',
          code: 'render_failed',
        });
        onError?.(toErrorInfo('render_failed'));
      }}
    >
      <RenderCommit instance={instance} runId={runId} pending={pending}>
        <RegisteredComponent props={props} actions={actions} status={status} />
      </RenderCommit>
    </RenderBoundary>
  );
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
  if (!resolved.ok) {
    return (
      <RejectedInteraction
        key={key}
        instance={instance}
        runId={run.runId}
        pending={pending}
        error={resolved.error}
        fallback={fallback}
        onError={onError}
      />
    );
  }
  return (
    <RenderedInteraction
      key={key}
      instance={instance}
      runId={run.runId}
      pending={pending}
      entry={resolved.entry}
      props={resolved.props}
      fallback={fallback}
      onError={onError}
    />
  );
}
