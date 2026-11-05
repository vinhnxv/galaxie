// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentInstance, AgentSnapshot } from '@galaxie/core';
import { useCallback, useSyncExternalStore } from 'react';

/** Subscribes to host-owned state without taking ownership of the instance lifecycle. */
export function useAgentSnapshot<Input, View>(
  instance: AgentInstance<Input, View>,
): AgentSnapshot<View> {
  const subscribe = useCallback((listener: () => void) => instance.subscribe(listener), [instance]);
  const getSnapshot = useCallback(() => instance.getSnapshot(), [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
