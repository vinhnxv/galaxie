// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { assertSpanTree, serializeSpans } from '../../../packages/core/test/span-tree.js';
import { decodeSpans, snapshotSpans } from '../src/oracle.js';
import { runScenario } from '../src/scenarios.js';

test('the page snapshot preserves the complete oracle through JSON', async () => {
  const result = await runScenario('linear', { text: true, live: false });
  const decoded = decodeSpans(JSON.parse(JSON.stringify(snapshotSpans(result.spans))));
  expect(serializeSpans(decoded)).toBe(serializeSpans(result.spans));
  expect(decoded.map((span) => span.ended)).toEqual([true, true, true]);
  expect(assertSpanTree(decoded, { text: 'allowed' })).toEqual(
    assertSpanTree(result.spans, { text: 'allowed' }),
  );
});

test.each(['parent', 'event', 'link', 'message'] as const)(
  'snapshot keeps a broken %s visible to the tree guard',
  async (mutation) => {
    const result = await runScenario('linear', { text: false, live: false });
    const snapshot = snapshotSpans(result.spans);
    const child = snapshot.find((span) => span.parent !== null);
    if (!child) throw new Error('Missing child');
    if (mutation === 'parent') child.parent = null;
    if (mutation === 'event') child.events.push({ name: 'unexpected', time: [0, 0] });
    if (mutation === 'link') child.links.push({ context: child.context });
    if (mutation === 'message') child.status.message = 'unexpected';
    expect(() => assertSpanTree(decodeSpans(snapshot))).toThrow();
  },
);
