// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { parseMessage } from '../src/retrieval/protocol.js';

test.each(['visitor', 'A.z_0:team-7', 'a'.repeat(128)])(
  'accepts a principal matching the core scope rule: %s',
  (principalScope) => {
    const message = {
      id: 1,
      type: 'init',
      input: { appId: 'app_1-test', principalScope, mock: true },
    };
    expect(parseMessage(message)).toEqual(message);
  },
);

test.each([undefined, '', 'two words', 'a/b', 'a'.repeat(129)])(
  'rejects an invalid or missing principal: %s',
  (principalScope) => {
    expect(() =>
      parseMessage({ id: 1, type: 'init', input: { appId: 'app', principalScope, mock: true } }),
    ).toThrow('The retrieval message is invalid.');
  },
);

test.each(['', 'app.name', 'app:team', 'a'.repeat(101)])(
  'preserves the narrower app ID rule: %s',
  (appId) => {
    expect(() =>
      parseMessage({
        id: 1,
        type: 'init',
        input: { appId, principalScope: 'visitor', mock: true },
      }),
    ).toThrow('The retrieval message is invalid.');
  },
);
