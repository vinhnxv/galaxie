// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';

test('importing the kit touches no DOM or Worker globals and installs nothing', async () => {
  vi.resetModules();
  const names = [
    'window',
    'document',
    'Worker',
    'SharedWorker',
    'self',
    'navigator',
    'addEventListener',
  ];
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const touched: string[] = [];
  try {
    for (const name of names)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get: () => {
          touched.push(name);
          throw new Error(`Unexpected global read: ${name}`);
        },
      });
    const before = Reflect.ownKeys(globalThis);
    const kit = await import('../src/index.js');
    expect(kit.resolveProvider).toBeTypeOf('function');
    expect(touched).toEqual([]);
    expect(Reflect.ownKeys(globalThis)).toEqual(before);
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    });
  }
});
