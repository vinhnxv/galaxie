// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ReactElement, type ReactNode, useId } from 'react';
import { SubmissionError } from '../components/submission-error.js';
import type { ActionDefinitions, BoundActions, InteractionStatus } from '../registry.js';
import type { AccessibilityAttributes, PreparedComponent } from './prepare.js';

function Accessible({
  attributes,
  children,
}: {
  readonly attributes: AccessibilityAttributes;
  readonly children: ReactNode;
}): ReactElement {
  const descriptionId = useId();
  return (
    <div
      // A label needs a role that supports naming; the spread keeps the pair together.
      {...(attributes.label === undefined ? {} : { role: 'group', 'aria-label': attributes.label })}
      aria-describedby={attributes.description === undefined ? undefined : descriptionId}
      aria-live={attributes.live}
      aria-hidden={attributes.hidden}
      hidden={attributes.hidden}
    >
      {children}
      {attributes.description === undefined ? null : (
        <span id={descriptionId} hidden>
          {attributes.description}
        </span>
      )}
    </div>
  );
}

export function SurfaceTree({
  node,
  status,
  actions,
  rejectionOwner,
}: {
  readonly node: PreparedComponent;
  readonly status: InteractionStatus;
  readonly rejectionOwner: string | undefined;
  readonly actions: (node: PreparedComponent) => BoundActions<ActionDefinitions>;
}): ReactElement {
  const errorId = useId();
  const componentStatus =
    typeof status === 'object' && rejectionOwner !== node.id ? 'idle' : status;
  const RegisteredComponent = node.entry.component;
  const content = (
    <>
      <RegisteredComponent
        props={node.props}
        actions={actions(node)}
        status={componentStatus}
        {...(node.children === undefined
          ? {}
          : {
              children: node.children.map((child) => (
                <SurfaceTree
                  key={child.key}
                  node={child}
                  status={status}
                  actions={actions}
                  rejectionOwner={rejectionOwner}
                />
              )),
            })}
      />
      {node.entry.actions['continue'] !== undefined &&
      node.entry.actions['submit'] === undefined ? (
        <SubmissionError id={errorId} status={componentStatus} />
      ) : null}
    </>
  );
  return node.accessibility === undefined ? (
    content
  ) : (
    <Accessible attributes={node.accessibility}>{content}</Accessible>
  );
}
