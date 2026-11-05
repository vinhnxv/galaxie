// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { isLoopback, isPrivateAddress } from '../src/urls.js';

test.each([
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.2',
  '169.254.1.2',
  '127.0.0.2',
  '[fc00::1]',
  '[fdff::1]',
  '[fe80::1]',
  '[febf::1]',
  '[::ffff:127.0.0.1]',
  '[::ffff:10.0.0.1]',
  '[::ffff:172.16.0.1]',
  '[::ffff:192.168.1.1]',
  '[::ffff:169.254.1.1]',
  'model.local',
  'MODEL.LOCAL.',
])('recognizes the LAN or private hostname %s without resolving DNS', (host) => {
  expect(isPrivateAddress(new URL(`https://${host}`).hostname)).toBe(true);
});

test.each([
  '172.15.255.255',
  '172.32.0.1',
  '192.169.0.1',
  '169.255.0.1',
  '8.8.8.8',
  '[2001:db8::1]',
  '[fe7f::1]',
  '[fec0::1]',
  '[::ffff:8.8.8.8]',
  '[::ffff:172.32.0.1]',
  '10.example',
  'model.local.example',
])('does not classify the public hostname %s as private', (host) => {
  expect(isPrivateAddress(new URL(`https://${host}`).hostname)).toBe(false);
});

test.each(['localhost', '127.0.0.1', '[::1]'])('retains loopback recognition for %s', (host) => {
  expect(isLoopback(new URL(`http://${host}`).hostname)).toBe(true);
});
