// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import { createEvent } from '@google/adk';
import { expect, test } from 'vitest';
import {
  decodeRecord,
  encodeRecord,
  restoredContent,
  revisionId,
  SESSION_TYPE,
  STATE_TYPE,
} from '../src/persist.js';

const key = new Uint8Array(32).fill(7);
const digest = async (): Promise<string> => 'a'.repeat(64);
const events = [
  createEvent({ author: 'user', content: { role: 'user', parts: [{ text: 'hello' }] } }),
  createEvent({ author: 'agent', content: { role: 'model', parts: [{ text: 'hi' }] } }),
];

function stored(bytes: { checkpoint: Uint8Array; metadata: Uint8Array }, id = revisionId(1)) {
  return {
    id,
    checkpoint: { type: SESSION_TYPE, bytes: bytes.checkpoint },
    metadata: { type: STATE_TYPE, bytes: bytes.metadata },
  };
}

test('a record round-trips its events, ordinal and key', async () => {
  const bytes = encodeRecord('s1', { events, ordinal: 3 }, key);
  const record = await decodeRecord('s1', digest, stored(bytes));
  expect(record.events.map((event) => event.content?.parts?.[0]?.text)).toEqual(['hello', 'hi']);
  expect(record.ordinal).toBe(3);
  expect([...record.key]).toEqual([...key]);
  expect(record.revision).toBe(1);
  expect(restoredContent(record)).toEqual(['hello', 'hi']);
});

test('the key is stored only in the metadata, never in the checkpoint', () => {
  const bytes = encodeRecord('s1', { events, ordinal: 0 }, key);
  const text = new TextDecoder().decode(bytes.checkpoint);
  expect(text).not.toContain(btoa(String.fromCharCode(...key)));
  expect(new TextDecoder().decode(bytes.metadata)).toContain(btoa(String.fromCharCode(...key)));
});

test('partial, binary and unknown-field events are refused on write', () => {
  const binary = createEvent({
    author: 'agent',
    content: { role: 'model', parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }] },
  });
  expect(() => encodeRecord('s1', { events: [binary], ordinal: 0 }, key)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
  const extra = { ...events[0], surprise: true } as unknown as (typeof events)[number];
  expect(() => encodeRecord('s1', { events: [extra], ordinal: 0 }, key)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});

test('a record for another session, a bad revision or a bad key is unrecoverable', async () => {
  const bytes = encodeRecord('s1', { events, ordinal: 0 }, key);
  await expect(decodeRecord('s2', digest, stored(bytes))).rejects.toMatchObject({
    code: 'unrecoverable',
  });
  await expect(decodeRecord('s1', digest, stored(bytes, 'one'))).rejects.toMatchObject({
    code: 'unrecoverable',
  });
  const short = encodeRecord('s1', { events, ordinal: 0 }, new Uint8Array(8));
  await expect(decodeRecord('s1', digest, stored(short))).rejects.toMatchObject({
    code: 'unrecoverable',
  });
});

test('a record whose body is not valid JSON or has an extra field is unrecoverable', async () => {
  const bytes = encodeRecord('s1', { events, ordinal: 0 }, key);
  const garbled = { ...bytes, checkpoint: new TextEncoder().encode('{"v":1') };
  await expect(decodeRecord('s1', digest, stored(garbled))).rejects.toMatchObject({
    code: 'unrecoverable',
  });
  const body = JSON.parse(new TextDecoder().decode(bytes.checkpoint));
  body.extra = 1;
  const widened = { ...bytes, checkpoint: new TextEncoder().encode(JSON.stringify(body)) };
  await expect(decodeRecord('s1', digest, stored(widened))).rejects.toMatchObject({
    code: 'unrecoverable',
  });
});

test('revision IDs sort in revision order', () => {
  expect(revisionId(2) < revisionId(10)).toBe(true);
});
