// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

// Dependency-free so Node 24 can regenerate and validate before installing this workspace.
const seed = 20261107;
const domains = ['tutor', 'support', 'write-confirmation', 'privacy'] as const;
type Domain = (typeof domains)[number];
type Kind = 'boolean' | 'choice' | 'score';
interface Entry {
  id: string;
  domain: Domain;
  type: Kind;
  state: string;
  prompt: string;
  options: null | Record<string, string> | { levels: number; legend: Record<string, string> };
  label: boolean | string | number;
  split: 'calibration' | 'evaluation';
}
function booleanCase(domain: Domain, yes: boolean, slot: number): [string, string, boolean] {
  switch (domain) {
    case 'tutor':
      return [
        `Exercise ${slot} is ${yes ? 'complete' : 'incomplete'}. Completion requires all steps.`,
        'Are all required steps complete?',
        yes,
      ];
    case 'support':
      return [
        `Ticket ${slot} has ${yes ? 'an active' : 'no active'} subscription. Only active subscriptions include priority care.`,
        'Does this ticket qualify for priority care?',
        yes,
      ];
    case 'write-confirmation':
      return [
        `Draft ${slot}: the user has ${yes ? 'already confirmed' : 'not confirmed'} this exact write. Confirmation is mandatory.`,
        'Has the user confirmed this exact write?',
        yes,
      ];
    case 'privacy':
      return [
        `Document ${slot} is labeled ${yes ? 'private-user' : 'public'}. The default policy keeps private-user documents in the browser.`,
        'Does this document require browser-only processing?',
        yes,
      ];
  }
}
function choiceCase(
  domain: Domain,
  route: number,
  slot: number,
): [string, string, Record<string, string>, string] {
  const cases: Record<
    Domain,
    { keys: string[]; labels: string[]; states: string[]; prompt: string }
  > = {
    tutor: {
      keys: ['hint', 'practice', 'advance'],
      labels: ['Offer a hint', 'Repeat practice', 'Advance lesson'],
      states: ['needs a hint', 'needs repeated practice', 'is ready to advance'],
      prompt: 'Which lesson action matches the recorded need?',
    },
    support: {
      keys: ['billing', 'delivery', 'technical'],
      labels: ['Billing queue', 'Delivery queue', 'Technical queue'],
      states: ['an invoice issue', 'a parcel issue', 'a software error'],
      prompt: 'Which support queue owns this issue?',
    },
    'write-confirmation': {
      keys: ['ask', 'submit', 'stop'],
      labels: ['Ask for confirmation', 'Submit confirmed write', 'Stop after denial'],
      states: ['pending confirmation', 'confirmed for this exact write', 'denied by the user'],
      prompt: 'Which action follows the recorded confirmation state?',
    },
    privacy: {
      keys: ['browser', 'public-index', 'backend'],
      labels: ['Browser-only processing', 'Public index lookup', 'Authorized backend capability'],
      states: [
        'private-user text for local processing',
        'a public catalog lookup',
        'a private database update requiring backend authorization',
      ],
      prompt: 'Which destination matches the stated operation and policy?',
    },
  };
  const item = cases[domain];
  const key = item.keys[route];
  assert.ok(key);
  return [
    `Synthetic case ${slot} concerns ${item.states[route]}.`,
    item.prompt,
    Object.fromEntries(item.keys.map((key, index) => [key, item.labels[index] ?? key])),
    key,
  ];
}
function generate(): {
  schema: string;
  seed: number;
  splitPolicy: string;
  eceBins: number;
  questions: Entry[];
} {
  const questions: Entry[] = [];
  for (const [domainIndex, domain] of domains.entries()) {
    for (const type of ['boolean', 'choice', 'score'] as const) {
      const count = type === 'boolean' ? 18 : 16;
      for (let index = 0; index < count; index++) {
        const slot = seed + domainIndex * 100 + index;
        const id = `${domain}-${type}-${String(index + 1).padStart(2, '0')}`;
        const split = index % 2 === 0 ? 'calibration' : 'evaluation';
        if (type === 'boolean') {
          const [state, prompt, label] = booleanCase(domain, Math.floor(index / 2) % 2 === 0, slot);
          questions.push({ id, domain, type, state, prompt, options: null, label, split });
        } else if (type === 'choice') {
          const [state, prompt, options, label] = choiceCase(
            domain,
            (Math.floor(index / 2) + domainIndex) % 3,
            slot,
          );
          questions.push({ id, domain, type, state, prompt, options, label, split });
        } else {
          const completed = (Math.floor(index / 2) + domainIndex) % 5;
          questions.push({
            id,
            domain,
            type,
            state: `Synthetic ${domain} checklist ${slot}: ${completed} of 4 required checks are complete. The recorded level is completed checks plus one.`,
            prompt: 'What is the recorded checklist level on the five-level scale?',
            options: {
              levels: 5,
              legend: {
                '1': 'No checks',
                '2': 'One check',
                '3': 'Two checks',
                '4': 'Three checks',
                '5': 'All four checks',
              },
            },
            label: completed + 1,
            split,
          });
        }
      }
    }
  }
  return {
    schema: 'galaxie.spike-decision-models.questions/v1',
    seed,
    splitPolicy:
      'Even template index: calibration; odd: evaluation; paired slots stratified by domain and type.',
    eceBins: 10,
    questions,
  };
}
function validate(entries: Entry[]): void {
  assert.equal(entries.length, 200);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 200);
  for (const type of ['boolean', 'choice', 'score']) {
    assert.ok(entries.filter((entry) => entry.type === type).length >= 40);
    for (const domain of domains) {
      const group = entries.filter((entry) => entry.domain === domain && entry.type === type);
      assert.equal(group.filter((entry) => entry.split === 'calibration').length, group.length / 2);
    }
  }
  for (const entry of entries) {
    if (entry.type === 'boolean') assert.equal(typeof entry.label, 'boolean');
    if (entry.type === 'choice') {
      assert.ok(
        entry.options &&
          Object.keys(entry.options).length >= 3 &&
          Object.keys(entry.options).length <= 5,
      );
      assert.ok(typeof entry.label === 'string' && Object.hasOwn(entry.options, entry.label));
    }
    if (entry.type === 'score') {
      assert.ok(entry.options && 'levels' in entry.options);
      const levels = Number(entry.options['levels']);
      assert.ok(levels >= 2 && levels <= 10);
      assert.ok(
        typeof entry.label === 'number' &&
          Number.isInteger(entry.label) &&
          entry.label >= 1 &&
          entry.label <= levels,
      );
    }
  }
}
const data = generate();
validate(data.questions);
const bytes = `${JSON.stringify(data, null, 2)}\n`;
assert.equal(bytes, `${JSON.stringify(generate(), null, 2)}\n`, 'deterministic_regeneration');
const path = new URL('../data/questions.json', import.meta.url);
if (process.argv.includes('--check'))
  assert.equal(await readFile(path, 'utf8'), bytes, 'committed_questions_byte_identical');
else {
  await writeFile(path, bytes);
  assert.equal(await readFile(path, 'utf8'), bytes);
}
console.log(
  '200 unique, valid labels; domain/type-balanced 100/100 splits; byte-identical regeneration.',
);
