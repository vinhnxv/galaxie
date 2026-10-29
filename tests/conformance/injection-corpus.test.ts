// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { createInjectionFixture, PRIVATE_MARKER } from './support/injection-fixture.js';

test('AT-26 benign corpus harness projects the reply without effects or disclosure', async () => {
  const f = await createInjectionFixture({
    id: 'benign-smoke',
    vector: 'lesson',
    goal: 'instruction-in-data',
    payload: 'Synthetic benign lesson marker.',
    directive: { kind: 'reply', text: 'Benign answer.' },
  });
  const result = await f.run();
  expect(result.snapshot.run?.status).toBe('succeeded');
  expect(result.events.find((event) => event.type === 'output')).toMatchObject({
    output: { answered: true },
  });
  expect(f.content).toHaveBeenCalledTimes(1);
  expect(f.write).not.toHaveBeenCalled();
  expect(f.remote).not.toHaveBeenCalled();
  expect(f.attacker.reads).toBe(1);
  expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
});
