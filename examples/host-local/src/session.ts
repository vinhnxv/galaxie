// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { IndexedDBSaver, type SessionExport } from '@galaxie-ai/storage-indexeddb';

export const hostAppId = 'galaxie-host-local';
export const hostLearnerId = 'local-demo-learner';
export const sessionKey: string = `${hostAppId}:${hostLearnerId}:session`;

export function downloadSession(exported: SessionExport): void {
  const blob = new Blob([JSON.stringify(exported)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = exported.personalContent
      ? 'galaxie-session-answers.json'
      : 'galaxie-session-summary.json';
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

export async function invalidateLocalPrincipal(): Promise<void> {
  const saver = await IndexedDBSaver.open({ appId: hostAppId, principalScope: hostLearnerId });
  try {
    await saver.invalidatePrincipal();
  } finally {
    saver.close();
  }
}
