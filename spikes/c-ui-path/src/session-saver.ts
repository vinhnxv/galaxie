// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { MemorySaver } from '@langchain/langgraph/web';

export const SAVER_KEY = 'spike-c-checkpoints';
export const THREAD_KEY = 'spike-c-thread';

export class SessionSaver extends MemorySaver {
  constructor() {
    super();
    const saved = sessionStorage.getItem(SAVER_KEY);
    if (saved !== null) {
      const restored = JSON.parse(saved, (_key, value) => {
        if (value !== null && typeof value === 'object' && '$bytes' in value) {
          return Uint8Array.from(atob(value.$bytes), (character) => character.charCodeAt(0));
        }
        return value;
      });
      this.storage = restored.storage;
      this.writes = restored.writes;
    }
  }

  private persist(): void {
    sessionStorage.setItem(
      SAVER_KEY,
      JSON.stringify({ storage: this.storage, writes: this.writes }, (_key, value) =>
        value instanceof Uint8Array ? { $bytes: btoa(String.fromCharCode(...value)) } : value,
      ),
    );
  }

  override async put(...args: Parameters<MemorySaver['put']>): ReturnType<MemorySaver['put']> {
    const result = await super.put(...args);
    this.persist();
    return result;
  }

  override async putWrites(...args: Parameters<MemorySaver['putWrites']>): Promise<void> {
    await super.putWrites(...args);
    this.persist();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.persist();
  }

  checkpointCount(): number {
    return Object.values(this.storage).reduce(
      (total, namespaces) =>
        total +
        Object.values(namespaces).reduce(
          (count, checkpoints) => count + Object.keys(checkpoints).length,
          0,
        ),
      0,
    );
  }
}
