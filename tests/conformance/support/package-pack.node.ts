// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function packPackage(directory: string, destination: string, ignoreScripts = false): string {
  execFileSync(
    'pnpm',
    [
      'pack',
      ...(ignoreScripts ? ['--config.ignore-scripts=true'] : []),
      '--pack-destination',
      destination,
    ],
    { cwd: directory, encoding: 'utf8', timeout: 300_000 },
  );
  const filenames = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (filenames.length !== 1) throw new Error(`Expected one tarball in ${destination}.`);
  return join(destination, filenames[0] as string);
}
