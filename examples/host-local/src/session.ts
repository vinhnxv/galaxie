// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const hostAppId = 'galaxie-host-local';
export const hostLearnerId = 'local-demo-learner';
export const sessionKey: string = `${hostAppId}:${hostLearnerId}:session`;

/** Holds the principal's session lock until the caller disposes its instance and releases it. */
export async function claimSession(): Promise<(() => Promise<void>) | undefined> {
  const acquired = Promise.withResolvers<boolean>();
  const released = Promise.withResolvers<void>();
  const holding = navigator.locks.request(sessionKey, { ifAvailable: true }, async (lock) => {
    acquired.resolve(lock !== null);
    if (lock !== null) await released.promise;
  });
  void holding.catch(acquired.reject);
  if (!(await acquired.promise)) {
    await holding;
    return undefined;
  }
  return async () => {
    released.resolve();
    await holding;
  };
}
