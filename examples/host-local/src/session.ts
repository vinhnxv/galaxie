// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { IndexedDBSaver } from '@galaxie/storage-indexeddb';

export const hostAppId = 'galaxie-host-local';
export const hostLearnerId = 'local-demo-learner';
export const sessionKey: string = `${hostAppId}:${hostLearnerId}:session`;

export async function invalidateLocalPrincipal(): Promise<void> {
  const saver = await IndexedDBSaver.open({ appId: hostAppId, principalScope: hostLearnerId });
  try {
    await saver.invalidatePrincipal();
  } finally {
    saver.close();
  }
}
