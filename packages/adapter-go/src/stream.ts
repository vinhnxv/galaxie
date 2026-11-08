// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { sameJson } from '@galaxie-ai/adapter-kit';
import type { ExecutorEvent } from '@galaxie-ai/core';
import type { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { concat } from '@langchain/core/utils/stream';
import { adapterFailure } from './errors.js';
import { GO_EXECUTOR_ID } from './protocol.js';
import { fragmentsOf } from './tool-calls.js';

export const MAX_DELTA_LENGTH = 4096;
const MAX_QUEUED_EVENTS = 256;

export interface StreamSink {
  readonly events: ExecutorEvent[];
  wake?: () => void;
  room?: { readonly promise: Promise<void>; readonly resolve: () => void };
  position: number;
  cancelled: boolean;
}

/** Releases any producer waiting for room when the run ends. */
export function closeStream(sink: StreamSink): void {
  sink.cancelled = true;
  sink.room?.resolve();
}

async function push(
  sink: StreamSink,
  mode: 'messages' | 'updates',
  data: () => unknown,
): Promise<void> {
  while (!sink.cancelled && sink.events.length >= MAX_QUEUED_EVENTS) {
    const room = sink.room ?? Promise.withResolvers<void>();
    sink.room = room;
    await room.promise;
    if (sink.room === room) delete sink.room;
  }
  if (sink.cancelled) throw adapterFailure('cancelled');
  sink.events.push({ type: 'stream', executor: GO_EXECUTOR_ID, path: [], mode, data: data() });
  sink.wake?.();
}

/** A content-free step marker: the offered function or capability name and a run-wide position. */
export function emitMarker(
  sink: StreamSink,
  step: 'tool_call' | 'tool_result',
  tool: string,
): Promise<void> {
  return push(sink, 'updates', () => ({ step, tool, index: sink.position++ }));
}

/** The marker for a run that stops to wait for the user; it names no tool and holds no content. */
export function emitPaused(sink: StreamSink): void {
  if (sink.cancelled) return;
  sink.events.push({
    type: 'stream',
    executor: GO_EXECUTOR_ID,
    path: [],
    mode: 'updates',
    data: { step: 'paused', index: sink.position++ },
  });
  sink.wake?.();
}

export function emitDelta(sink: StreamSink, author: string, text: string): Promise<void> {
  return push(sink, 'messages', () => ({ author, text }));
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Cuts checked reply text into `messages` deltas of at most `MAX_DELTA_LENGTH` characters. A
 * high surrogate that ends a provider chunk is held back until the next chunk completes the pair,
 * so no event ever carries half a character.
 */
export class DeltaSplitter {
  #held = '';

  feed(text: string): string[] {
    const whole = this.#held + text;
    this.#held = '';
    if (whole.length === 0) return [];
    let end = whole.length;
    if (isHigh(whole.charCodeAt(end - 1))) {
      this.#held = whole.slice(end - 1);
      end -= 1;
    }
    const pieces: string[] = [];
    for (let start = 0; start < end; ) {
      let stop = Math.min(start + MAX_DELTA_LENGTH, end);
      if (stop < end && isHigh(whole.charCodeAt(stop - 1))) stop -= 1;
      pieces.push(whole.slice(start, stop));
      start = stop;
    }
    return pieces;
  }
}

export function carriesCalls(chunk: AIMessage | AIMessageChunk): boolean {
  return (
    (chunk.tool_calls?.length ?? 0) > 0 ||
    (chunk.invalid_tool_calls?.length ?? 0) > 0 ||
    fragmentsOf(chunk).length > 0 ||
    chunk.additional_kwargs['tool_calls'] !== undefined
  );
}

/**
 * Joins a provider's chunks and keeps the raw call-argument fragments beside the join. Native
 * concatenation repairs cut-off argument JSON and can drop a complete call that arrives next to
 * fragments, so `finish` compares the joined calls with what the provider actually sent.
 */
export class StreamJoiner {
  #joined: AIMessage | AIMessageChunk | undefined;
  readonly #slots = new Map<string, number>();
  readonly #raw: string[] = [];
  #complete = 0;

  /**
   * Adds one streamed piece. A provider without native streaming yields its whole reply as one
   * message that is not a chunk and may report an invalid call, so both kinds are accepted. Returns
   * the reply joined so far.
   */
  append(chunk: AIMessage | AIMessageChunk): AIMessage | AIMessageChunk {
    const pieces = fragmentsOf(chunk);
    // A fragment alone is rarely valid JSON, so only a provider-reported invalid call counts here.
    if (pieces.length === 0 && (chunk.invalid_tool_calls?.length ?? 0) > 0)
      throw adapterFailure('invalid');
    if (pieces.length === 0 && (chunk.tool_calls?.length ?? 0) > 0) this.#complete += 1;
    for (const [position, piece] of pieces.entries()) {
      const key = JSON.stringify(
        piece.index !== undefined
          ? ['index', piece.index]
          : piece.id !== undefined
            ? ['id', piece.id]
            : ['position', position],
      );
      let slot = this.#slots.get(key);
      if (slot === undefined) {
        slot = this.#raw.length;
        this.#slots.set(key, slot);
        this.#raw.push('');
      }
      this.#raw[slot] = (this.#raw[slot] ?? '') + (piece.args ?? '');
    }
    this.#joined =
      this.#joined === undefined
        ? chunk
        : concat(this.#joined as AIMessageChunk, chunk as AIMessageChunk);
    return this.#joined;
  }

  finish(): AIMessage | AIMessageChunk {
    const joined = this.#joined;
    if (joined === undefined) throw adapterFailure('unavailable');
    if (this.#complete > 0 && (this.#raw.length > 0 || this.#complete > 1))
      throw adapterFailure('unsupported');
    if (this.#raw.length > 0) {
      const calls = joined.tool_calls ?? [];
      if (calls.length !== this.#raw.length) throw adapterFailure('invalid');
      for (const [slot, text] of this.#raw.entries())
        if (!sameJson(text === '' ? '{}' : text, calls[slot]?.args))
          throw adapterFailure('invalid');
    }
    return joined;
  }
}
