// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export type GatewayState = 'ready' | 'denied' | 'quota_exceeded' | 'unavailable';

export interface GatewayStateEntry {
  readonly message: string;
  readonly control: 'retry' | null;
}

export const gatewayStates: Readonly<Record<GatewayState, GatewayStateEntry>> = {
  ready: { message: 'Gateway route: host server.', control: null },
  denied: {
    message: 'Gateway access was denied. Retry to request a new demo session.',
    control: 'retry',
  },
  quota_exceeded: {
    message: 'The gateway quota is exceeded. Wait for the quota window, then retry.',
    control: 'retry',
  },
  unavailable: { message: 'The gateway is unavailable. Retry later.', control: 'retry' },
};

export function gatewayStateForStatus(status: number): GatewayState {
  if (status === 401 || status === 403) return 'denied';
  if (status === 429) return 'quota_exceeded';
  if (status >= 200 && status < 300) return 'ready';
  return 'unavailable';
}
