// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import type { InteractionId, ViewRevision } from '@galaxie-ai/core';
import { createEvent } from '@google/adk';
import { expect, test } from 'vitest';
import type { PausedCall } from '../src/interaction.js';
import {
  decodeRecord,
  encodeRecord,
  pauseAuthor,
  restoredContent,
  revisionId,
  SESSION_TYPE,
  type SessionRecord,
  STATE_TYPE,
} from '../src/persist.js';

const key = new Uint8Array(32).fill(7);
const digest = async (): Promise<string> => 'a'.repeat(64);
const events = [
  createEvent({ author: 'user', content: { role: 'user', parts: [{ text: 'hello' }] } }),
  createEvent({ author: 'agent', content: { role: 'model', parts: [{ text: 'hi' }] } }),
];

const longCall: PausedCall = {
  id: 'call_1',
  name: 'docs_save_1',
  request: { kind: 'long-running', tool: 'docs_save_1', args: { q: 'note' } },
};
const callEvent = createEvent({
  id: 'event_1',
  timestamp: 1,
  invocationId: 'turn_1',
  author: 'agent',
  content: {
    role: 'model',
    parts: [{ functionCall: { id: 'call_1', name: 'docs_save_1', args: { q: 'note' } } }],
  },
});
const pausedRecord: SessionRecord = {
  events: [callEvent],
  ordinal: 1,
  pause: {
    interaction: {
      interactionId: 'a'.repeat(64) as InteractionId,
      surfaceId: 'main',
      viewRevision: 'r1' as ViewRevision,
      component: 'tests.Approval/v1',
      props: { count: 1 },
    },
    calls: [longCall],
  },
};

const checkpoint =
  '{"v":1,"conversationId":"s1","ordinal":1,"events":[{"id":"event_1","timestamp":1,"invocationId":"turn_1","author":"agent","content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"docs_save_1","args":{"q":"note"}}}]},"actions":{"stateDelta":{},"artifactDelta":{},"requestedAuthConfigs":{},"requestedToolConfirmations":{}},"longRunningToolIds":[]}],"pause":{"interaction":{"interactionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","surfaceId":"main","viewRevision":"r1","component":"tests.Approval/v1","props":{"count":1}},"calls":[{"id":"call_1","name":"docs_save_1","request":{"kind":"long-running","tool":"docs_save_1","args":{"q":"note"}}}]}}';

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

test.each([
  { agentState: { b: { progress: 1 } } },
  { agentState: null },
  { endOfAgent: true },
  { endOfAgent: false },
  { endOfAgent: null },
])('workflow-state actions %j are refused on write', (actions) => {
  const event = createEvent({ author: 'agent' });
  Object.assign(event.actions, actions);
  expect(() => encodeRecord('s1', { events: [event], ordinal: 0 }, key)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
});

test('an undefined workflow-state action still encodes', () => {
  const event = createEvent({ author: 'agent' });
  Object.assign(event.actions, { agentState: undefined });
  expect(() => encodeRecord('s1', { events: [event], ordinal: 0 }, key)).not.toThrow();
});

test.each([{ agentState: { b: { progress: 1 } } }, { endOfAgent: false }, { endOfAgent: null }])(
  'workflow-state actions %j are unrecoverable with or without a pause',
  async (actions) => {
    for (const paused of [false, true]) {
      const bytes = encodeRecord('s1', paused ? pausedRecord : { events, ordinal: 0 }, key);
      const body = JSON.parse(new TextDecoder().decode(bytes.checkpoint));
      Object.assign(body.events[0].actions, actions);
      await expect(
        decodeRecord(
          's1',
          digest,
          stored({
            ...bytes,
            checkpoint: new TextEncoder().encode(JSON.stringify(body)),
          }),
        ),
      ).rejects.toMatchObject({ code: 'unrecoverable' });
    }
  },
);

test('pause authors come from every matching call event, including confirmation requests', () => {
  const confirmation: PausedCall = {
    id: 'confirm_1',
    name: 'adk_request_confirmation',
    request: { ...longCall.request, kind: 'confirmation' },
    gated: { id: longCall.id, name: longCall.name },
  };
  const confirming = createEvent({
    author: 'agent',
    content: {
      role: 'model',
      parts: [{ functionCall: { id: confirmation.id, name: confirmation.name, args: {} } }],
    },
  });
  expect(pauseAuthor([confirmation], [callEvent, confirming])).toBe('agent');
  expect(pauseAuthor([confirmation], [callEvent])).toBeUndefined();
  expect(pauseAuthor([longCall], [callEvent])).toBe('agent');
  const second = { ...longCall, id: 'call_2' };
  const combined = createEvent({
    author: 'agent',
    content: {
      role: 'model',
      parts: [longCall, second].map((call) => ({
        functionCall: { id: call.id, name: call.name, args: call.request.args },
      })),
    },
  });
  expect(pauseAuthor([longCall, second], [combined])).toBe('agent');
  expect(pauseAuthor([longCall, second], [callEvent])).toBeUndefined();
  const unauthored = { ...callEvent };
  delete unauthored.author;
  expect(pauseAuthor([longCall], [unauthored])).toBeUndefined();
  expect(pauseAuthor([longCall], [callEvent, { ...callEvent, author: 'other' }])).toBeUndefined();
  expect(pauseAuthor([longCall], [callEvent, unauthored])).toBeUndefined();
  expect(pauseAuthor([longCall], [callEvent, { ...callEvent }])).toBe('agent');
  const different = createEvent({
    author: 'other',
    content: {
      role: 'model',
      parts: [{ functionCall: { id: second.id, name: second.name, args: second.request.args } }],
    },
  });
  expect(pauseAuthor([longCall, second], [callEvent, different])).toBeUndefined();
  expect(pauseAuthor([], [callEvent])).toBeUndefined();
});

test('the version-one checkpoint bytes stay unchanged and an older literal restores its author', async () => {
  const bytes = encodeRecord('s1', pausedRecord, key);
  expect(new TextDecoder().decode(bytes.checkpoint)).toBe(checkpoint);
  const restored = await decodeRecord(
    's1',
    digest,
    stored({
      checkpoint: new TextEncoder().encode(checkpoint),
      metadata: bytes.metadata,
    }),
  );
  expect(restored.pause).toEqual(pausedRecord.pause);
  expect(pauseAuthor(restored.pause?.calls ?? [], restored.events)).toBe('agent');
});

test('a confirmation requires its gated call and request to have one defined author', () => {
  const confirmation: PausedCall = {
    id: 'confirm_1',
    name: 'adk_request_confirmation',
    request: { ...longCall.request, kind: 'confirmation' },
    gated: { id: longCall.id, name: longCall.name },
  };
  const confirming = createEvent({
    author: 'agent',
    content: {
      role: 'model',
      parts: [{ functionCall: { id: confirmation.id, name: confirmation.name, args: {} } }],
    },
  });
  expect(
    pauseAuthor([confirmation], [{ ...callEvent, author: 'other' }, confirming]),
  ).toBeUndefined();
  const unauthored = { ...callEvent };
  delete unauthored.author;
  expect(pauseAuthor([confirmation], [unauthored, confirming])).toBeUndefined();
  expect(pauseAuthor([confirmation], [confirming])).toBeUndefined();
  const { gated: _, ...withoutGated } = confirmation;
  expect(pauseAuthor([withoutGated], [confirming])).toBe('agent');
});

test.each(['event', 'actions'])('nodeInfo on %s is refused on write and read', async (location) => {
  const event = createEvent({ author: 'agent' });
  Object.assign(location === 'event' ? event : event.actions, { nodeInfo: {} });
  expect(() => encodeRecord('s1', { events: [event], ordinal: 0 }, key)).toThrow(
    expect.objectContaining({ code: 'unsupported' }),
  );
  const bytes = encodeRecord('s1', { events, ordinal: 0 }, key);
  const body = JSON.parse(new TextDecoder().decode(bytes.checkpoint));
  Object.assign(location === 'event' ? body.events[0] : body.events[0].actions, { nodeInfo: {} });
  await expect(
    decodeRecord(
      's1',
      digest,
      stored({
        ...bytes,
        checkpoint: new TextEncoder().encode(JSON.stringify(body)),
      }),
    ),
  ).rejects.toMatchObject({ code: 'unrecoverable' });
});
