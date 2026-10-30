// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RawData } from '@orama/orama';
import { sha256 } from '../corpus.js';
import type { IndexedPassage } from './index.js';
import { modelRevision } from './model-files.js';
import { embeddingSettings, libraryVersions, schemaVersion, tokenizerRule } from './settings.js';

export interface CacheRecord {
  fingerprint: string;
  saved: RawData;
  pasted: IndexedPassage[];
  count: number;
}
export interface CacheRead {
  epoch: number;
  record?: CacheRecord;
}
const epochsName = 'galaxie-rag:epochs';

export async function fingerprint(corpusDigest: string, mock: boolean): Promise<string> {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        modelRevision,
        embeddingSettings,
        libraryVersions,
        tokenizerRule,
        schemaVersion,
        corpusDigest,
        mock,
      }),
    ),
  );
}
function open(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(store);
    };
    request.onerror = () => reject(new Error('The retrieval cache is unavailable.'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('The retrieval cache is unavailable.'));
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new Error('The retrieval cache is unavailable.'));
    transaction.onerror = () => reject(new Error('The retrieval cache is unavailable.'));
  });
}
async function readValue<T>(name: string, store: string, key: string): Promise<T | undefined> {
  const database = await open(name, store);
  try {
    const transaction = database.transaction(store, 'readonly');
    const [value] = await Promise.all([
      requestResult(transaction.objectStore(store).get(key) as IDBRequest<T | undefined>),
      completed(transaction),
    ]);
    return value;
  } finally {
    database.close();
  }
}
async function putValue(name: string, store: string, key: string, value: unknown): Promise<void> {
  const database = await open(name, store);
  try {
    const transaction = database.transaction(store, 'readwrite');
    const done = completed(transaction);
    transaction.objectStore(store).put(value, key);
    await done;
  } finally {
    database.close();
  }
}
async function removeDatabase(name: string): Promise<void> {
  const request = indexedDB.deleteDatabase(name);
  await requestResult(request);
}

export class IndexCache {
  readonly name: string;
  private readonly channel: BroadcastChannel;
  constructor(appId: string, onClear: (epoch: number) => void = () => {}) {
    this.name = `galaxie-rag:${appId}`;
    this.channel = new BroadcastChannel(this.name);
    this.channel.onmessage = (event: MessageEvent<unknown>): void => {
      const value = event.data;
      if (
        value !== null &&
        typeof value === 'object' &&
        'type' in value &&
        value.type === 'clear' &&
        'epoch' in value &&
        Number.isSafeInteger(value.epoch) &&
        Number(value.epoch) > 0
      )
        onClear(Number(value.epoch));
    };
  }
  private async epoch(): Promise<number> {
    return (await readValue<number>(epochsName, 'epochs', this.name)) ?? 0;
  }
  async currentEpoch(): Promise<number> {
    return navigator.locks.request(this.name, () => this.epoch());
  }
  async load(expected: string): Promise<CacheRead> {
    return navigator.locks.request(this.name, async () => {
      const epoch = await this.epoch();
      const stored = await readValue<CacheRecord>(this.name, 'index', expected);
      if (stored?.fingerprint === expected) return { epoch, record: stored };
      await removeDatabase(this.name);
      return { epoch };
    });
  }
  async save(expectedEpoch: number, record: CacheRecord): Promise<boolean> {
    return navigator.locks.request(this.name, async () => {
      if ((await this.epoch()) !== expectedEpoch) return false;
      const database = await open(this.name, 'index');
      try {
        const transaction = database.transaction('index', 'readwrite');
        const done = completed(transaction);
        transaction.objectStore('index').clear();
        transaction.objectStore('index').put(record, record.fingerprint);
        await done;
      } finally {
        database.close();
      }
      return true;
    });
  }
  async clear(): Promise<number> {
    return navigator.locks.request(this.name, async () => {
      const epoch = (await this.epoch()) + 1;
      await putValue(epochsName, 'epochs', this.name, epoch);
      await removeDatabase(this.name);
      this.channel.postMessage({ type: 'clear', epoch });
      return epoch;
    });
  }
  close(): void {
    this.channel.close();
  }
}
