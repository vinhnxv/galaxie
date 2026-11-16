// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StarterModule } from './manifest.js';

export interface NoticeOptions {
  readonly modules: readonly { readonly path: string; readonly version: string }[];
  readonly lock: readonly StarterModule[];
  readonly allowedLicenses: readonly string[];
  readonly classifyLicense: (text: string) => string;
  readonly goroot: string;
  readonly moduleCache: string;
}

export async function collectNotices(
  options: NoticeOptions,
): Promise<{ readonly text: string; readonly modules: readonly StarterModule[] }> {
  const goLicense = await readFile(join(options.goroot, 'LICENSE'), 'utf8');
  if (
    options.classifyLicense(goLicense) !== 'BSD-3-Clause' ||
    !options.allowedLicenses.includes('BSD-3-Clause')
  )
    throw new Error('The Go license is not allowed.');
  const sections = [`Go standard library and wasm_exec.js (BSD-3-Clause)\n\n${goLicense}`];
  const modules: StarterModule[] = [];
  for (const module of [...options.modules].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const locked = options.lock.find(
      (item) => item.path === module.path && item.version === module.version,
    );
    if (!locked)
      throw new Error(
        `The compiled module ${module.path}@${module.version} is absent from the Go lock.`,
      );
    const escaped = module.path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
    const directory = join(options.moduleCache, `${escaped}@${module.version}`);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      throw new Error(`The module license is missing: ${module.path}@${module.version}.`);
    }
    const licenses: string[] = [];
    for (const name of names.filter((name) => /^(LICEN[SC]E|COPYING)/i.test(name)).sort()) {
      const text = await readFile(join(directory, name), 'utf8');
      const license = options.classifyLicense(text);
      if (license !== locked.license || !options.allowedLicenses.includes(license))
        throw new Error(
          `The module license is not allowed: ${module.path}@${module.version} (${license}).`,
        );
      licenses.push(text);
    }
    if (licenses.length === 0)
      throw new Error(`The module license is missing: ${module.path}@${module.version}.`);
    for (const name of names.filter((name) => /^NOTICE(?:[.-]|$)/i.test(name)).sort())
      licenses.push(await readFile(join(directory, name), 'utf8'));
    sections.push(
      `${module.path}@${module.version} (${locked.license})\n\n${licenses.join('\n\n')}`,
    );
    modules.push({ path: module.path, version: module.version, license: locked.license });
  }
  return {
    text: `${sections.join('\n\n----------------------------------------\n\n')}\n`,
    modules,
  };
}
