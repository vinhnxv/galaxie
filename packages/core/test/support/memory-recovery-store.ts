// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { EffectId, InteractionId, SessionId } from '../../src/ids.js';
import type { EffectRecord, RecoveryStore, RecoverySubmission } from '../../src/recovery.js';

/** A durable-for-the-test store shared by successive runtime instances. */
export class MemoryRecoveryStore implements RecoveryStore {
  readonly inbox: Map<string, RecoverySubmission> = new Map();
  readonly journal: Map<string, EffectRecord> = new Map();

  async acceptSubmission(
    sessionId: SessionId,
    entry: Omit<RecoverySubmission, 'status'>,
  ): Promise<'accepted' | 'duplicate'> {
    const key = JSON.stringify([sessionId, entry.interactionId]);
    if (this.inbox.has(key)) return 'duplicate';
    this.inbox.set(key, structuredClone({ ...entry, status: 'accepted' }));
    return 'accepted';
  }

  async consumeSubmission(sessionId: SessionId, interactionId: InteractionId): Promise<void> {
    const entry = this.inbox.get(JSON.stringify([sessionId, interactionId]));
    if (entry !== undefined)
      this.inbox.set(JSON.stringify([sessionId, interactionId]), { ...entry, status: 'consumed' });
  }

  async submissions(sessionId: SessionId): Promise<RecoverySubmission[]> {
    return [...this.inbox]
      .filter(([key]) => JSON.parse(key)[0] === sessionId)
      .map(([, entry]) => structuredClone(entry));
  }

  async effect(sessionId: SessionId, effectId: EffectId): Promise<EffectRecord | undefined> {
    return structuredClone(this.journal.get(JSON.stringify([sessionId, effectId])));
  }

  async recordEffect(
    sessionId: SessionId,
    effectId: EffectId,
    record: EffectRecord,
  ): Promise<void> {
    this.journal.set(JSON.stringify([sessionId, effectId]), structuredClone(record));
  }
}
