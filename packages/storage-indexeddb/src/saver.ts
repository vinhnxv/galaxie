// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  maxChannelVersion,
  type PendingWrite,
  type SerializerProtocol,
  TASKS,
  WRITES_IDX_MAP,
  writesSortKey,
} from '@langchain/langgraph-checkpoint';
import { decode, type Envelope, encode } from './envelope.js';
import { StorageError, type StorageErrorCode } from './errors.js';
import { Fencing } from './fencing.js';
import {
  type CheckpointKey,
  checkpointKey,
  compareObjectKeys,
  prefixRange,
  validateKey,
  validateScope,
} from './keys.js';
import { IndexedDBRecovery } from './recovery.js';
import {
  deleteSessionRecords,
  type SweepOptions,
  type SweepResult,
  storageClock,
  sweep,
  touchSession,
} from './retention.js';
import {
  assertConnection,
  manageConnection,
  observeError,
  openDatabase,
  operationError,
  requestResult,
  storageOperation,
  transact,
} from './schema.js';

export interface IndexedDBSaverOptions {
  readonly appId: string;
  readonly principalScope: string;
  readonly databaseName?: string;
  readonly serde?: SerializerProtocol;
  readonly onError?: (code: StorageErrorCode) => void;
  readonly onVersionChange?: () => void;
}

interface CheckpointRecord {
  readonly v: 1;
  readonly key: CheckpointKey;
  readonly thread: string[];
  readonly namespace: string[];
  readonly checkpoint: Envelope;
  readonly metadata: Envelope;
  readonly parentId: string | null;
  readonly threadOrder: number;
  readonly namespaceOrder: number;
  readonly savedAt?: number;
}

interface WriteRecord {
  readonly v: 1;
  readonly key: [...CheckpointKey, string, number];
  readonly thread: string[];
  readonly checkpoint: CheckpointKey;
  readonly channel: string;
  readonly value: Envelope;
  readonly taskPath: string;
  readonly order: number;
  readonly retainedForHistory?: true;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function sameKey(value: unknown, expected: IDBValidKey[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (!Object.hasOwn(value, index) || value[index] !== expected[index]) return false;
  }
  return true;
}

function readCheckpoint(value: unknown): CheckpointRecord {
  if (
    !object(value) ||
    value['v'] !== 1 ||
    !Array.isArray(value['key']) ||
    value['key'].length !== 5 ||
    !value['key'].every((part: unknown) => typeof part === 'string') ||
    !sameKey(value['thread'], value['key'].slice(0, 3)) ||
    !sameKey(value['namespace'], value['key'].slice(0, 4)) ||
    !('checkpoint' in value) ||
    !('metadata' in value) ||
    !(value['parentId'] === null || typeof value['parentId'] === 'string') ||
    !positive(value['threadOrder']) ||
    !positive(value['namespaceOrder'])
  )
    throw new StorageError('corrupt');
  return value as unknown as CheckpointRecord;
}

function readWrite(value: unknown): WriteRecord {
  if (
    !object(value) ||
    value['v'] !== 1 ||
    !Array.isArray(value['key']) ||
    value['key'].length !== 7 ||
    !value['key'].slice(0, 6).every((part: unknown) => typeof part === 'string') ||
    !Number.isSafeInteger(value['key'][6]) ||
    !sameKey(value['thread'], value['key'].slice(0, 3)) ||
    !sameKey(value['checkpoint'], value['key'].slice(0, 5)) ||
    typeof value['channel'] !== 'string' ||
    typeof value['taskPath'] !== 'string' ||
    !positive(value['order']) ||
    !('value' in value)
  )
    throw new StorageError('corrupt');
  return value as unknown as WriteRecord;
}

function compareCheckpoints(a: CheckpointRecord, b: CheckpointRecord): number {
  return (
    compareObjectKeys(a.key[2], a.threadOrder, b.key[2], b.threadOrder) ||
    compareObjectKeys(a.key[3], a.namespaceOrder, b.key[3], b.namespaceOrder) ||
    (a.key[4] > b.key[4] ? -1 : a.key[4] < b.key[4] ? 1 : 0)
  );
}

/** Serializer-backed checkpoints; the host owns session identity and connection lifetime. */
export class IndexedDBSaver extends BaseCheckpointSaver {
  readonly recovery: IndexedDBRecovery;
  readonly fencing: Fencing;
  readonly #db: IDBDatabase;
  readonly #scope: [string, string];

  private constructor(db: IDBDatabase, options: IndexedDBSaverOptions, fencing: Fencing) {
    super(options.serde);
    this.#db = db;
    manageConnection(db, options);
    this.#scope = [options.appId, options.principalScope];
    this.fencing = fencing;
    this.recovery = new IndexedDBRecovery(db, this.#scope, fencing);
  }

  static async open(options: IndexedDBSaverOptions): Promise<IndexedDBSaver> {
    let db: IDBDatabase | undefined;
    try {
      validateScope(options.appId);
      validateScope(options.principalScope);
      if (
        options.databaseName !== undefined &&
        (typeof options.databaseName !== 'string' || options.databaseName.length === 0)
      )
        throw new StorageError('invalid');
      db = await openDatabase(
        options.databaseName ?? `galaxie:${options.appId}`,
        options.appId,
        options.principalScope,
      );
      return new IndexedDBSaver(db, options, await Fencing.open(db, options.appId));
    } catch (error) {
      db?.close();
      throw observeError(options.onError, error);
    }
  }

  close(): void {
    this.#db.close();
  }

  #key(thread: string, namespace: string, id: string): CheckpointKey {
    return checkpointKey(...this.#scope, thread, namespace, id);
  }

  async #pending(writes: WriteRecord[]): Promise<CheckpointPendingWrite[]> {
    const ordered = writes.toSorted((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.taskPath, a.key[5], a.key[6]),
        writesSortKey(b.taskPath, b.key[5], b.key[6]),
      ),
    );
    return Promise.all(
      ordered.map(
        async (write): Promise<CheckpointPendingWrite> => [
          write.key[5],
          write.channel,
          await decode(this.serde, write.value),
        ],
      ),
    );
  }

  async #tuple(
    row: CheckpointRecord,
    writes: WriteRecord[],
    parentWrites: WriteRecord[],
    config?: RunnableConfig,
  ): Promise<CheckpointTuple> {
    const checkpoint = await decode(this.serde, row.checkpoint);
    const metadata = await decode(this.serde, row.metadata);
    if (
      !object(checkpoint) ||
      typeof checkpoint['v'] !== 'number' ||
      typeof checkpoint['id'] !== 'string' ||
      typeof checkpoint['ts'] !== 'string' ||
      !object(checkpoint['channel_values']) ||
      !object(checkpoint['channel_versions']) ||
      !object(checkpoint['versions_seen']) ||
      !object(metadata)
    )
      throw new StorageError('corrupt');
    const restored = checkpoint as unknown as Checkpoint;
    if (restored.v < 4 && row.parentId !== null) {
      restored.channel_values[TASKS] = await Promise.all(
        parentWrites
          .toSorted((a, b) => a.order - b.order)
          .filter((write) => write.channel === TASKS)
          .map((write) => decode(this.serde, write.value)),
      );
      const versions = Object.values(restored.channel_versions);
      restored.channel_versions[TASKS] =
        versions.length > 0 ? maxChannelVersion(...versions) : this.getNextVersion(undefined);
    }
    const tuple: CheckpointTuple = {
      config: config ?? {
        configurable: {
          thread_id: row.key[2],
          checkpoint_ns: row.key[3],
          checkpoint_id: row.key[4],
        },
      },
      checkpoint: restored,
      metadata: metadata as CheckpointMetadata,
      pendingWrites: await this.#pending(writes),
    };
    if (row.parentId !== null)
      tuple.parentConfig = {
        configurable: {
          thread_id: row.key[2],
          checkpoint_ns: row.key[3],
          checkpoint_id: row.parentId,
        },
      };
    return tuple;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return storageOperation(this.#db, async () => {
      const thread: unknown = config.configurable?.['thread_id'];
      const namespace: unknown = config.configurable?.['checkpoint_ns'] ?? '';
      const id = getCheckpointId(config);
      if (thread !== undefined) validateKey(thread);
      validateKey(namespace, true);
      if (id) validateKey(id);
      if (thread === undefined) return undefined;
      const saved = await transact(this.#db, ['checkpoints', 'writes'], 'readonly', async (tx) => {
        const store = tx.objectStore('checkpoints');
        const key = this.#key(thread, namespace, id);
        const raw: unknown = id
          ? await requestResult(store.get(key))
          : (await requestResult(store.openCursor(prefixRange(key.slice(0, 4)), 'prev')))?.value;
        if (raw === undefined) return undefined;
        const row = readCheckpoint(raw);
        const storeWrites = tx.objectStore('writes');
        const writes: unknown[] = await requestResult(storeWrites.getAll(prefixRange(row.key)));
        const parent: unknown[] =
          row.parentId === null
            ? []
            : await requestResult(
                storeWrites.getAll(prefixRange(this.#key(thread, namespace, row.parentId))),
              );
        return { row, writes: writes.map(readWrite), parent: parent.map(readWrite) };
      });
      return saved === undefined
        ? undefined
        : await this.#tuple(saved.row, saved.writes, saved.parent, id ? config : undefined);
    });
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    try {
      assertConnection(this.#db);
      const thread: unknown = config.configurable?.['thread_id'];
      const namespace: unknown = config.configurable?.['checkpoint_ns'];
      const id: unknown = config.configurable?.['checkpoint_id'];
      const before: unknown = options?.before?.configurable?.['checkpoint_id'];
      if (thread !== undefined) validateKey(thread);
      if (namespace !== undefined) validateKey(namespace, true);
      if (id) validateKey(id);
      if (before) validateKey(before);
      const saved = await transact(this.#db, ['checkpoints', 'writes'], 'readonly', async (tx) => {
        const query = prefixRange(thread === undefined ? this.#scope : [...this.#scope, thread]);
        const rows: unknown[] = await requestResult(tx.objectStore('checkpoints').getAll(query));
        const writes: unknown[] = await requestResult(tx.objectStore('writes').getAll(query));
        return { rows: rows.map(readCheckpoint), writes: writes.map(readWrite) };
      });
      let limit = options?.limit;
      for (const row of saved.rows.sort(compareCheckpoints)) {
        if (namespace !== undefined && row.key[3] !== namespace) continue;
        if (id && row.key[4] !== id) continue;
        if (typeof before === 'string' && before && row.key[4] >= before) continue;
        const metadata = await decode(this.serde, row.metadata);
        if (!object(metadata)) throw new StorageError('corrupt');
        if (
          options?.filter &&
          !Object.entries(options.filter).every(([key, value]) => metadata[key] === value)
        )
          continue;
        if (limit !== undefined) {
          if (limit <= 0) break;
          limit--;
        }
        const related = saved.writes.filter((write) => sameKey(write.checkpoint, row.key));
        const parentKey =
          row.parentId === null ? undefined : this.#key(row.key[2], row.key[3], row.parentId);
        const parent =
          parentKey === undefined
            ? []
            : saved.writes.filter((write) => sameKey(write.checkpoint, parentKey));
        yield await this.#tuple(row, related, parent);
      }
    } catch (error) {
      throw operationError(this.#db, error);
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return storageOperation(this.#db, async () => {
      const thread: unknown = config.configurable?.['thread_id'];
      const namespace: unknown = config.configurable?.['checkpoint_ns'] ?? '';
      const parent: unknown = config.configurable?.['checkpoint_id'];
      validateKey(thread);
      validateKey(namespace, true);
      validateKey(checkpoint.id);
      if (parent !== undefined) validateKey(parent, true);
      const [encodedCheckpoint, encodedMetadata] = await Promise.all([
        encode(this.serde, copyCheckpoint(checkpoint)),
        encode(this.serde, metadata),
      ]);
      const key = this.#key(thread, namespace, checkpoint.id);
      await this.fencing.write(['checkpoints', 'meta'], async (tx) => {
        const meta = tx.objectStore('meta');
        const sequenceKey = [...this.#scope, 'sequence'];
        const current: unknown = await requestResult(meta.get(sequenceKey));
        if (
          current !== undefined &&
          (!object(current) || current['v'] !== 1 || !positive(current['sequence']))
        )
          throw new StorageError('corrupt');
        let sequence = object(current) ? (current['sequence'] as number) : 0;
        const order = async (key: string[]): Promise<number> => {
          const stored: unknown = await requestResult(meta.get(key));
          if (stored !== undefined) {
            if (!object(stored) || stored['v'] !== 1 || !positive(stored['order']))
              throw new StorageError('corrupt');
            return stored['order'];
          }
          sequence++;
          if (!positive(sequence)) throw new StorageError('unavailable');
          await requestResult(meta.put({ v: 1, order: sequence }, key));
          return sequence;
        };
        const threadOrder = await order([...this.#scope, 'thread', thread]);
        const namespaceOrder = await order([...this.#scope, 'namespace', thread, namespace]);
        await requestResult(meta.put({ v: 1, sequence }, sequenceKey));
        const savedAt = storageClock.now();
        await touchSession(tx, this.#scope, thread, savedAt);
        const row: CheckpointRecord = {
          savedAt,
          v: 1,
          key,
          thread: key.slice(0, 3),
          namespace: key.slice(0, 4),
          checkpoint: encodedCheckpoint,
          metadata: encodedMetadata,
          parentId: parent ?? null,
          threadOrder,
          namespaceOrder,
        };
        await requestResult(tx.objectStore('checkpoints').put(row));
      });
      return {
        configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: checkpoint.id },
      };
    });
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = '',
  ): Promise<void> {
    return storageOperation(this.#db, async () => {
      const thread: unknown = config.configurable?.['thread_id'];
      const namespace: unknown = config.configurable?.['checkpoint_ns'];
      const id: unknown = config.configurable?.['checkpoint_id'];
      validateKey(thread);
      validateKey(namespace, true);
      validateKey(id);
      validateKey(taskId);
      if (typeof taskPath !== 'string') throw new StorageError('invalid');
      const serialized = await Promise.all(
        writes.map(async ([channel, value], index) => ({
          channel,
          value: await encode(this.serde, value),
          index: WRITES_IDX_MAP[channel] || index,
        })),
      );
      const checkpoint = this.#key(thread, namespace, id);
      await this.fencing.write(['writes', 'meta'], async (tx) => {
        await touchSession(tx, this.#scope, thread);
        const store = tx.objectStore('writes');
        const raw: unknown[] = await requestResult(store.getAll(prefixRange(checkpoint)));
        const existing = raw.map(readWrite);
        let order = existing.reduce((max, row) => Math.max(max, row.order), 0);
        for (const write of serialized) {
          const previous = existing.find(
            (row) => row.key[5] === taskId && row.key[6] === write.index,
          );
          if (previous !== undefined && write.index >= 0) continue;
          const row: WriteRecord = {
            v: 1,
            key: [...checkpoint, taskId, write.index],
            checkpoint,
            thread: checkpoint.slice(0, 3),
            channel: write.channel,
            value: write.value,
            taskPath,
            order: previous?.order ?? ++order,
          };
          await requestResult(store.put(row));
        }
      });
    });
  }

  async sweep(options?: SweepOptions): Promise<SweepResult> {
    return storageOperation(this.#db, async () => {
      return await sweep(this.#db, this.#scope, this.fencing, options);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    return storageOperation(this.#db, async () => {
      validateKey(sessionId);
      await this.fencing.write(['checkpoints', 'writes', 'inbox', 'journal', 'meta'], (tx) =>
        deleteSessionRecords(tx, this.#scope, sessionId),
      );
    });
  }

  override async deleteThread(threadId: string): Promise<void> {
    return storageOperation(this.#db, async () => {
      validateKey(threadId);
      await this.fencing.write(['checkpoints', 'writes', 'meta'], async (tx) => {
        const range = prefixRange([...this.#scope, threadId]);
        await requestResult(tx.objectStore('checkpoints').delete(range));
        await requestResult(tx.objectStore('writes').delete(range));
        const meta = tx.objectStore('meta');
        await requestResult(meta.delete([...this.#scope, 'thread', threadId]));
        await requestResult(meta.delete(prefixRange([...this.#scope, 'namespace', threadId])));
      });
    });
  }
}
