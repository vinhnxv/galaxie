// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { AgentInstance, DestinationClass } from '@galaxie/core';
import type { ReactElement } from 'react';
import { useAgentSnapshot } from './hooks.js';

const destinationLabels: Readonly<Record<DestinationClass, string>> = {
  'in-browser': 'In browser',
  'user-device': 'User device',
  'user-endpoint': 'User endpoint',
  'host-server': 'Host server',
  'third-party': 'Third party',
};

export interface ModelRoutesProps<Input, View> {
  readonly instance: AgentInstance<Input, View>;
  /** Trusted host text; unlabeled roles and providers use their snapshot identifiers. */
  readonly labels?: {
    readonly roles?: Readonly<Record<string, string>>;
    readonly providers?: Readonly<Record<string, string>>;
  };
  readonly destinationLabels?: Partial<Readonly<Record<DestinationClass, string>>>;
}

/** Announces selected routes without owning the instance lifecycle or rendering model output. */
export function ModelRoutes<Input, View>({
  instance,
  labels,
  destinationLabels: overrides,
}: ModelRoutesProps<Input, View>): ReactElement {
  const routes = Object.entries(useAgentSnapshot(instance).routes ?? {});
  const destinationLabel = (destination: DestinationClass): string =>
    overrides?.[destination] ?? destinationLabels[destination];
  return (
    <div aria-live="polite">
      {routes.length > 0 && (
        <ul aria-label="Model destinations">
          {routes.map(([role, route]) => (
            <li key={role}>
              {labels?.roles?.[role] ?? role}:{' '}
              {labels?.providers?.[route.providerId] ?? route.providerId} (
              {destinationLabel(route.destination)})
              {route.changedFrom !== undefined &&
                ` changed from ${destinationLabel(route.changedFrom)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
