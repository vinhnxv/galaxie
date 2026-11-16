// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

interface Manifest {
  readonly name: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

const repo = fileURLToPath(new URL('../..', import.meta.url));
const packages = readdirSync(join(repo, 'packages'))
  .map(
    (name) =>
      JSON.parse(readFileSync(join(repo, 'packages', name, 'package.json'), 'utf8')) as Manifest,
  )
  .filter((manifest) => manifest.private !== true);
const guide = readFileSync(join(repo, 'docs/releasing.md'), 'utf8');
const section = guide.split('## Publish order\n')[1]?.split('\n## ')[0] ?? '';
const order = [...section.matchAll(/^\d+\. `(@galaxie-ai\/[a-z-]+)`/gm)].map(
  (match) => match[1] as string,
);

test('the release guide lists every public package once, with manifest dependencies first', () => {
  expect([...order].sort()).toEqual(packages.map(({ name }) => name).sort());
  for (const pkg of packages)
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const)
      for (const dependency of Object.keys(pkg[section] ?? {})) {
        if (!dependency.startsWith('@galaxie-ai/')) continue;
        expect(order, `${pkg.name} requires public ${dependency}`).toContain(dependency);
        expect(order.indexOf(dependency), `${dependency} before ${pkg.name}`).toBeLessThan(
          order.indexOf(pkg.name),
        );
      }
});

test('release policy puts starters and adapters before create, and create last', () => {
  expect(order.at(-1)).toBe('@galaxie-ai/create');
  for (const { name } of packages.filter(({ name }) =>
    /^@galaxie-ai\/(?:starter|adapter)-/.test(name),
  ))
    expect(order.indexOf(name), `${name} before create`).toBeLessThan(
      order.indexOf('@galaxie-ai/create'),
    );
});
