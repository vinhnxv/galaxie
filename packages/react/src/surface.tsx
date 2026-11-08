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
} from '@galaxie-ai/core';
import {
  Component,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SurfaceChanges } from './a2ui/changes.js';
import { type PreparedComponent, prepareSurface } from './a2ui/prepare.js';
import { SurfaceTree } from './a2ui/tree.js';
import { useAlertFocus } from './components/alert-focus.js';
import { useAgentSnapshot } from './hooks.js';
import type { ActionDefinitions, BoundActions, InteractionStatus, Registry } from './registry.js';

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
  readonly identity: string;
}> {
  override state: { readonly failed: boolean; readonly identity: string | undefined } = {
    failed: false,
    identity: undefined,
  };
  private reported: string | undefined;

  static getDerivedStateFromProps(
    props: { readonly identity: string },
    state: { readonly identity: string | undefined },
  ): { readonly failed: boolean; readonly identity: string } | null {
    return props.identity === state.identity ? null : { failed: false, identity: props.identity };
  }

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    if (this.reported === this.props.identity) return;
    this.reported = this.props.identity;
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
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    const identity = JSON.stringify([pending.interactionId, pending.viewRevision]);
    if (reported.current === identity) return;
    reported.current = identity;
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
  root,
  fallback,
  onError,
}: InteractionIdentity<Input, View> & {
  readonly root: PreparedComponent;
  readonly fallback: AgentSurfaceProps['fallback'];
  readonly onError: AgentSurfaceProps['onError'];
}): ReactElement | null {
  const identity = JSON.stringify([pending.interactionId, pending.viewRevision]);
  const [current, setCurrent] = useState(() => ({
    identity,
    status: 'idle' as InteractionStatus,
    rejectionOwner: undefined as string | undefined,
    guard: { current: 'idle' },
  }));
  let state = current;
  if (state.identity !== identity) {
    state = { identity, status: 'idle', rejectionOwner: undefined, guard: { current: 'idle' } };
    setCurrent(state);
  }
  const updateStatus = (status: InteractionStatus, owner?: string): void => {
    setCurrent((latest) =>
      latest.identity === identity
        ? { ...latest, status, rejectionOwner: typeof status === 'object' ? owner : undefined }
        : latest,
    );
  };
  const actions = (node: PreparedComponent): BoundActions<ActionDefinitions> =>
    Object.fromEntries(
      Object.entries(node.entry.actions).map(([name, action]) => [
        name,
        {
          label: action.label,
          async submit(payload: unknown): Promise<DispatchReceipt> {
            if (instance.getSnapshot().run?.runId === runId && state.guard.current !== 'idle')
              return rejected('duplicate');
            if (!validateSync(action.payload, payload).ok) {
              updateStatus({ rejected: 'invalid' }, node.id);
              return rejected('invalid');
            }
            state.guard.current = 'submitting';
            updateStatus('submitting');
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
                ...(pending.surface === undefined
                  ? {}
                  : {
                      surfaceAction: {
                        revision: pending.surface.revision,
                        componentId: node.id,
                        dataModel: pending.surface.dataModel,
                      },
                    }),
              });
            } catch {
              receipt = rejected('executor_error');
            }
            state.guard.current = receipt.status === 'accepted' ? 'accepted' : 'idle';
            updateStatus(
              receipt.status === 'accepted' ? 'accepted' : { rejected: receipt.error.code },
              node.id,
            );
            return receipt;
          },
        },
      ]),
    );
  return (
    <RenderBoundary
      identity={identity}
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
        <SurfaceTree
          node={root}
          actions={actions}
          status={state.status}
          rejectionOwner={state.rejectionOwner}
        />
        <SurfaceChanges surface={pending.surface} />
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
  const [retained, setRetained] = useState<InteractionIdentity<Input, View>>();
  const observed = run?.pending?.surfaceId === surfaceId ? run.pending : undefined;
  // Core clears pending while resuming. Keep the native tree mounted until the next
  // interaction, so reconciliation can preserve drafts across a real executor gap.
  const pending =
    observed ??
    (run?.status === 'running' &&
    run.pending === undefined &&
    retained !== undefined &&
    retained.instance === instance &&
    retained.runId === run.runId &&
    retained.pending.surfaceId === surfaceId
      ? retained.pending
      : undefined);
  if (
    pending?.surface !== undefined &&
    run !== undefined &&
    (run.status === 'running' || run.status === 'waiting_input')
  ) {
    if (
      retained === undefined ||
      retained.instance !== instance ||
      retained.runId !== run.runId ||
      retained.pending !== pending
    )
      setRetained({ instance, runId: run.runId, pending });
  } else if (retained !== undefined) {
    setRetained(undefined);
  }
  const resolved = useMemo(
    () => (pending === undefined ? undefined : prepareSurface(pending, registry)),
    [pending, registry],
  );
  if (pending === undefined || run === undefined || resolved === undefined) return null;
  const key = JSON.stringify([
    snapshot.instanceId,
    run.runId,
    pending.surfaceId,
    ...(pending.surface === undefined
      ? [pending.interactionId, pending.viewRevision]
      : [pending.surface.a2uiSurfaceId]),
  ]);
  if (!resolved.ok) {
    return (
      <RejectedInteraction
        key={JSON.stringify([key, pending.interactionId, pending.viewRevision])}
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
      root={resolved.root}
      fallback={fallback}
      onError={onError}
    />
  );
}
