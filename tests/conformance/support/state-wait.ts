// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export function waitForState(
  subscribe: (listener: () => void) => () => unknown,
  assertion: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      try {
        assertion();
      } catch (error) {
        if (error instanceof Error && error.name === 'AssertionError') return;
        unsubscribe();
        reject(error);
        return;
      }
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribe(check);
    check();
  });
}

export function createNotifier(): {
  notify: () => void;
  subscribe: (listener: () => void) => () => unknown;
} {
  const listeners = new Set<() => void>();
  return {
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
