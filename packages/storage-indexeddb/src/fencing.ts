// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { StorageError } from './errors.js';
import { requestResult, storageOperation, transact } from './schema.js';

async function epoch(tx: IDBTransaction, appId: string): Promise<number> {
  const value: unknown = await requestResult(tx.objectStore('meta').get([appId]));
  if (value === undefined) return 0;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('v' in value) ||
    value.v !== 1 ||
    !('epoch' in value) ||
    typeof value.epoch !== 'number' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0
  )
    throw new StorageError('corrupt');
  return value.epoch;
}

export async function generation(
  tx: IDBTransaction,
  scope: readonly [string, string],
): Promise<number> {
  const value: unknown = await requestResult(tx.objectStore('meta').get([...scope, 'generation']));
  if (value === undefined) return 0;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('v' in value) ||
    value.v !== 1 ||
    !('generation' in value) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  )
    throw new StorageError('corrupt');
  return value.generation;
}

export class Fencing {
  readonly #db: IDBDatabase;
  readonly #appId: string;
  #held: number;
  readonly #scope: readonly [string, string];
  readonly #generation: number;

  private constructor(
    db: IDBDatabase,
    scope: readonly [string, string],
    held: number,
    generation: number,
  ) {
    this.#db = db;
    this.#appId = scope[0];
    this.#scope = scope;
    this.#generation = generation;
    this.#held = held;
  }

  static async open(db: IDBDatabase, appId: string, principalScope: string): Promise<Fencing> {
    const scope = [appId, principalScope] as const;
    return transact(
      db,
      ['meta'],
      'readonly',
      async (tx) => new Fencing(db, scope, await epoch(tx, appId), await generation(tx, scope)),
    );
  }

  async #checkGeneration(tx: IDBTransaction): Promise<void> {
    if ((await generation(tx, this.#scope)) !== this.#generation)
      throw new StorageError('invalidated');
  }

  async claim(): Promise<void> {
    await storageOperation(this.#db, async () => {
      const held = await transact(this.#db, ['meta'], 'readwrite', async (tx) => {
        await this.#checkGeneration(tx);
        const next = (await epoch(tx, this.#appId)) + 1;
        if (!Number.isSafeInteger(next)) throw new StorageError('unavailable');
        await requestResult(tx.objectStore('meta').put({ v: 1, epoch: next }, [this.#appId]));
        return next;
      });
      this.#held = held;
    });
  }

  async current(): Promise<boolean> {
    return storageOperation(this.#db, () =>
      transact(
        this.#db,
        ['meta'],
        'readonly',
        async (tx) =>
          (await generation(tx, this.#scope)) === this.#generation &&
          (await epoch(tx, this.#appId)) === this.#held,
      ),
    );
  }

  /** Check first, in the same transaction as every mutation. Never await external work here. */
  write<T>(stores: string[], work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return transact(this.#db, [...stores, 'meta'], 'readwrite', async (tx) => {
      await this.#checkGeneration(tx);
      if ((await epoch(tx, this.#appId)) !== this.#held) throw new StorageError('fenced');
      return work(tx);
    });
  }
}
