// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { parseArguments, UsageError } from '../src/args.js';

const choices = {
  kinds: ['browser-only', 'gateway'],
  frameworks: { 'browser-only': ['langgraph-js'], gateway: ['langgraph-js', 'adk-js'] },
};

test('positional and flag forms select the same request', () => {
  const expected = {
    directory: 'my-app',
    kind: 'browser-only',
    framework: 'langgraph-js',
    noInstall: true,
    help: false,
  };
  expect(
    parseArguments(['my-app', 'browser-only', 'langgraph-js', '--no-install'], choices),
  ).toEqual(expected);
  expect(
    parseArguments(
      ['--kind', 'browser-only', '--framework', 'langgraph-js', '--no-install', 'my-app'],
      choices,
    ),
  ).toEqual(expected);
  expect(parseArguments(['--help'], choices).help).toBe(true);
});

test.each([
  ['my-app', 'browser-only', '--kind', 'browser-only'],
  ['my-app', 'browser-only', 'langgraph-js', '--framework', 'langgraph-js'],
  ['--kind', 'browser-only', '--kind', 'gateway'],
  ['--framework', 'langgraph-js', '--framework', 'langgraph-js'],
  ['my-app', 'browser-only', 'langgraph-js', 'extra'],
  ['--unknown'],
  ['--kind'],
  ['--no-install=false'],
])('duplicate or malformed arguments are usage errors: %j', (...argv) => {
  expect(() => parseArguments(argv, choices)).toThrow(UsageError);
  expect(() => parseArguments(argv, choices)).toThrow('Valid kinds: browser-only, gateway');
  expect(parseArguments(['my-app', 'browser-only', 'langgraph-js'], choices).kind).toBe(
    'browser-only',
  );
});

test.each([
  ['my-app', 'unknown', 'langgraph-js'],
  ['my-app', 'browser-only', 'unknown'],
  ['my-app', 'browser-only', 'adk-js'],
])('invalid selections list the catalog without echoing the supplied value: %j', (...argv) => {
  expect(() => parseArguments(argv, choices)).toThrow('Valid frameworks');
  expect(() => parseArguments(argv, choices)).not.toThrow('unknown');
  expect(parseArguments(['my-app', 'gateway', 'adk-js'], choices).framework).toBe('adk-js');
});
