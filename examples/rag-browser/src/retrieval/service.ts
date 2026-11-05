// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type Corpus, parseCorpus, sha256 } from '../corpus.js';
import { fingerprint, IndexCache } from './cache.js';
import { chunkText } from './chunk.js';
import { createEmbedder, type Embedder, verifyWebGPU, webgpuMessage } from './embedder.js';
import { type IndexedPassage, RetrievalIndex } from './index.js';
import { downloadModelFiles, hasModelFiles, modelCacheName } from './model-files.js';
import {
  emptySnapshot,
  type InitInput,
  invalidMessage,
  parseMessage,
  type RetrievalEvent,
  type RetrievalSnapshot,
  type SearchResult,
} from './protocol.js';

const clearedMessage = 'The retrieval data was cleared. Please retry.';
const knownErrors = new Set([
  invalidMessage,
  webgpuMessage,
  clearedMessage,
  'The retrieval cache is unavailable.',
  'The embedding model download failed.',
  'The embedding model file failed verification.',
  'The WebGPU embedding model could not be started.',
  'The embedding result is invalid.',
  'The corpus is invalid.',
  'The corpus could not be loaded.',
  'The index is not ready.',
]);

export class RetrievalService {
  private readonly emit: (event: RetrievalEvent) => void;
  private snapshot: RetrievalSnapshot = { ...emptySnapshot };
  private input: InitInput | undefined;
  private corpus: Corpus | null = null;
  private digest: string = '';
  private cache: IndexCache | undefined;
  private epoch: number = 0;
  private index: RetrievalIndex | undefined;
  private embedder: Embedder | undefined;
  private pasted: IndexedPassage[] = [];
  constructor(emit: (event: RetrievalEvent) => void) {
    this.emit = emit;
  }
  private publish(update: Partial<RetrievalSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    this.emit({
      type: this.snapshot.status === 'ready' ? 'ready' : 'progress',
      snapshot: this.snapshot,
    });
  }
  private invalidate(epoch: number): void {
    if (epoch <= this.epoch) return;
    this.epoch = epoch;
    this.index = undefined;
    this.pasted = [];
    this.publish({ ...emptySnapshot, corpusMissing: this.corpus === null });
  }
  private async makeEmbedder(): Promise<Embedder> {
    if (this.embedder) return this.embedder;
    if (this.input?.mock) {
      const { createMockEmbedder } = await import('./mock-embedder.js');
      this.embedder = createMockEmbedder();
    } else {
      let loaded: Promise<Embedder> | undefined;
      this.embedder = {
        device: 'webgpu',
        async embed(texts, kind) {
          loaded ??= createEmbedder();
          return (await loaded).embed(texts, kind);
        },
        async dispose() {
          await (await loaded?.catch(() => undefined))?.dispose();
        },
      };
    }
    return this.embedder;
  }
  private async initialize(input: InitInput): Promise<void> {
    this.cache?.close();
    await this.embedder?.dispose();
    this.embedder = undefined;
    this.index = undefined;
    this.pasted = [];
    this.input = input;
    this.epoch = 0;
    this.corpus = input.corpus ?? null;
    let bytes = new TextEncoder().encode(JSON.stringify(this.corpus));
    if (input.corpusUrl) {
      try {
        const url = new URL(input.corpusUrl, location.origin);
        if (url.origin !== location.origin || url.pathname !== '/data/squad-dev.json')
          throw new Error();
        const response = await fetch(url, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (response.status !== 404) {
          if (!response.ok) throw new Error();
          bytes = new Uint8Array(await response.arrayBuffer());
          this.corpus = parseCorpus(JSON.parse(new TextDecoder().decode(bytes)));
        }
      } catch {
        throw new Error('The corpus could not be loaded.');
      }
    }
    this.digest = await fingerprint(await sha256(bytes), input.mock);
    this.cache = new IndexCache(input.appId, (epoch) => this.invalidate(epoch));
    this.snapshot = { ...emptySnapshot, corpusMissing: this.corpus === null };
    await this.prepare(false);
  }
  private async persist(
    index: RetrievalIndex,
    pasted: IndexedPassage[],
    epoch: number,
  ): Promise<void> {
    if (
      !this.cache ||
      !(await this.cache.save(epoch, {
        fingerprint: this.digest,
        saved: index.save(),
        pasted,
        count: index.count,
      }))
    ) {
      if (this.cache) this.invalidate((await this.cache.load(this.digest)).epoch);
      throw new Error(clearedMessage);
    }
  }
  private async prepare(consent: boolean): Promise<void> {
    if (!this.input || !this.cache) throw new Error('The index is not ready.');
    const loaded = await this.cache.load(this.digest);
    this.epoch = loaded.epoch;
    if (!this.input.mock) {
      const files = await caches.open(modelCacheName);
      const verified = await hasModelFiles(files);
      if (!verified && !consent) {
        this.publish({ status: 'awaiting-consent', message: null });
        return;
      }
      await verifyWebGPU();
      if (!verified) {
        this.publish({
          status: 'downloading',
          restored: false,
          loaded: 0,
          total: 0,
          message: null,
        });
        await downloadModelFiles(files, (loaded, total) => this.publish({ loaded, total }));
      }
    }
    const embedder = await this.makeEmbedder();
    if (this.epoch !== loaded.epoch) throw new Error(clearedMessage);
    if (loaded.record) {
      this.index = new RetrievalIndex(embedder, loaded.record.saved);
      this.pasted = loaded.record.pasted;
      this.publish({
        status: 'ready',
        count: this.index.count,
        pastedCount: this.pasted.length,
        restored: true,
        device: embedder.device,
        loaded: 0,
        total: 0,
        message: null,
      });
      return;
    }
    const index = new RetrievalIndex(embedder);
    this.publish({
      status: 'building',
      count: 0,
      pastedCount: 0,
      loaded: 0,
      total: this.corpus?.passages.length ?? 0,
      restored: false,
      message: null,
    });
    await index.add(
      (this.corpus?.passages ?? []).map((passage) => ({ ...passage, source: 'squad' })),
      (loaded, total) => this.publish({ loaded, total }),
    );
    await this.persist(index, [], loaded.epoch);
    if (this.epoch !== loaded.epoch) throw new Error(clearedMessage);
    this.index = index;
    this.pasted = [];
    this.publish({
      status: 'ready',
      count: index.count,
      pastedCount: 0,
      restored: false,
      device: embedder.device,
    });
  }
  private async fresh(): Promise<void> {
    if (!this.cache) throw new Error('The index is not ready.');
    const epoch = await this.cache.currentEpoch();
    if (epoch !== this.epoch) this.invalidate(epoch);
    if (!this.index) await this.prepare(false);
    if (!this.index || this.snapshot.status !== 'ready') throw new Error('The index is not ready.');
  }
  private async paste(text: string): Promise<void> {
    await this.fresh();
    const index = this.index;
    if (!index) throw new Error('The index is not ready.');
    const epoch = this.epoch;
    const additions: IndexedPassage[] = chunkText(text).map((text) => ({
      id: `pasted-${crypto.randomUUID()}`,
      title: 'Pasted text',
      text,
      source: 'pasted',
    }));
    this.publish({
      status: 'building',
      restored: false,
      loaded: 0,
      total: additions.length,
      added: 0,
    });
    await index.add(additions, (loaded, total) => this.publish({ loaded, total }));
    const pasted = [...this.pasted, ...additions];
    await this.persist(index, pasted, epoch);
    if (epoch !== this.epoch) throw new Error(clearedMessage);
    this.pasted = pasted;
    this.publish({
      status: 'ready',
      count: index.count,
      pastedCount: pasted.length,
      added: additions.length,
    });
  }
  async handle(value: unknown): Promise<void> {
    let id = 0;
    if (
      value !== null &&
      typeof value === 'object' &&
      'id' in value &&
      Number.isSafeInteger(value.id) &&
      Number(value.id) >= 0
    )
      id = Number(value.id);
    try {
      const message = parseMessage(value);
      let result: RetrievalSnapshot | SearchResult;
      switch (message.type) {
        case 'init':
          await this.initialize(message.input);
          result = this.snapshot;
          break;
        case 'consent':
          await this.prepare(true);
          result = this.snapshot;
          break;
        case 'paste':
          await this.paste(message.text);
          result = this.snapshot;
          break;
        case 'search': {
          await this.fresh();
          const epoch = this.epoch;
          if (!this.index) throw new Error('The index is not ready.');
          result = await this.index.search(message.input);
          if (epoch !== this.epoch) throw new Error(clearedMessage);
          break;
        }
        case 'clear': {
          if (!this.cache) throw new Error('The index is not ready.');
          this.invalidate(await this.cache.clear());
          result = this.snapshot;
          break;
        }
        case 'remove-model': {
          await this.embedder?.dispose();
          this.embedder = undefined;
          await caches.delete(modelCacheName);
          this.index = undefined;
          this.pasted = [];
          this.publish({
            ...emptySnapshot,
            status: 'awaiting-consent',
            corpusMissing: this.corpus === null,
          });
          result = this.snapshot;
          break;
        }
      }
      this.emit({ type: 'result', id: message.id, result });
    } catch (error) {
      const message =
        error instanceof Error && knownErrors.has(error.message)
          ? error.message
          : 'The retrieval operation failed.';
      this.snapshot = { ...this.snapshot, status: 'failed', message };
      this.emit({ type: 'failed', id, message, snapshot: this.snapshot });
    }
  }
  async dispose(): Promise<void> {
    this.cache?.close();
    await this.embedder?.dispose();
  }
}
