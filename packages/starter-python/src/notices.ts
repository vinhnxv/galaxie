// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { StarterWheel } from './manifest.js';

export const licenseExceptions: Readonly<Record<string, readonly string[]>> = {
  certifi: ['MPL-2.0'],
  orjson: ['MPL-2.0'],
  'typing-extensions': ['PSF-2.0'],
};
export const reviewFlags: Readonly<Record<string, string>> = {
  certifi: 'certifi: MPL-2.0 requires maintainer review before redistribution.',
  orjson:
    'orjson: MPL-2.0 text is shipped beside Apache/MIT and requires maintainer review before redistribution.',
  ormsgpack:
    'ormsgpack is a limited same-name stand-in, not upstream. Repository metadata says Apache-2.0; license to be confirmed by the maintainer. It is independently written with no copied upstream implementation. Its serializer compatibility is unverified; replacing it may make saved checkpoints unreadable.',
};

const aliases: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  distro: { 'Apache License, Version 2.0': 'Apache-2.0' },
  'requests-toolbelt': { 'Apache 2.0': 'Apache-2.0' },
  jsonpointer: { 'Modified BSD License': 'BSD-3-Clause' },
  xxhash: { BSD: 'BSD-2-Clause' },
};

export interface WheelContents {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly bytes: Uint8Array;
}
export interface NoticeOptions {
  readonly permissive: readonly string[];
  readonly repositoryLicense: string;
}

function everyLicenseTermAllowed(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = expression.match(/[a-zA-Z0-9.+-]+|[()]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s+/g, '')) return false;
  let position = 0;
  const atom = (): boolean => {
    const token = tokens[position++];
    if (token === '(') {
      const result = allAlternativesAllowed();
      return tokens[position++] === ')' && result;
    }
    return token !== undefined && allowed.has(token);
  };
  const and = (): boolean => {
    let result = atom();
    while (tokens[position] === 'AND') {
      position++;
      const next = atom();
      result = result && next;
    }
    return result;
  };
  const allAlternativesAllowed = (): boolean => {
    let result = and();
    while (tokens[position] === 'OR') {
      position++;
      const next = and();
      result = result && next;
    }
    return result;
  };
  return allAlternativesAllowed() && position === tokens.length;
}

function fields(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const header = text.replaceAll('\r\n', '\n').split('\n\n')[0] ?? '';
  for (const line of header.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const key = match[1].toLowerCase();
    result.set(key, [...(result.get(key) ?? []), match[2].trim()]);
  }
  return result;
}

export function collectNotices(
  wheels: readonly WheelContents[],
  options: NoticeOptions,
): { readonly text: string; readonly wheels: readonly StarterWheel[] } {
  const sections: string[] = [];
  const inventory: StarterWheel[] = [];
  for (const wheel of wheels) {
    const failure: () => never = () => {
      throw new Error(`The Python wheel license is not allowed or is missing: ${wheel.file}.`);
    };
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(wheel.bytes, {
        filter: ({ name }) =>
          /\.dist-info\/(?:METADATA$|.*(?:licen[sc]e|copying|notice|authors)[^/]*$)/i.test(name),
      });
    } catch {
      failure();
    }
    const metadataPaths = Object.keys(entries).filter((path) =>
      path.endsWith('.dist-info/METADATA'),
    );
    const metadataPath = metadataPaths[0];
    if (metadataPaths.length !== 1 || !metadataPath) failure();
    const metadata = fields(Buffer.from(entries[metadataPath] ?? []).toString('utf8'));
    const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');
    if (
      normalize(metadata.get('name')?.[0] ?? '') !== normalize(wheel.name) ||
      metadata.get('version')?.[0] !== wheel.version
    )
      failure();
    const declared = metadata.get('license-expression')?.[0] ?? metadata.get('license')?.[0] ?? '';
    const license = aliases[wheel.name]?.[declared] ?? declared;
    const allowed = new Set([...options.permissive, ...(licenseExceptions[wheel.name] ?? [])]);
    if (!everyLicenseTermAllowed(license, allowed)) failure();
    const prefix = metadataPath.slice(0, -'METADATA'.length);
    const licensePaths = Object.keys(entries)
      .filter((path) => path.startsWith(prefix) && path !== metadataPath)
      .sort();
    for (const name of metadata.get('license-file') ?? [])
      if (
        !licensePaths.includes(`${prefix}${name}`) &&
        !licensePaths.includes(`${prefix}licenses/${name}`)
      )
        failure();
    if (licensePaths.length === 0 && !['galaxie', 'ormsgpack'].includes(wheel.name)) failure();
    const texts = licensePaths.map(
      (path) => `${path}\n\n${Buffer.from(entries[path] ?? []).toString('utf8')}`,
    );
    if (licensePaths.length === 0)
      texts.push(
        `Repository LICENSE (local wheel metadata: ${license})\n\n${options.repositoryLicense}`,
      );
    if (wheel.name === 'orjson' && !licensePaths.some((path) => path.endsWith('LICENSE-MPL-2.0')))
      failure();
    sections.push(
      `${wheel.name}@${wheel.version}\nLicense (wheel metadata): ${license}\n${reviewFlags[wheel.name] ?? ''}\n\n${texts.join('\n\n')}`,
    );
    inventory.push({
      name: wheel.name,
      version: wheel.version,
      file: wheel.file,
      bytes: wheel.bytes.byteLength,
      sha256: createHash('sha256').update(wheel.bytes).digest('hex'),
      license,
    });
  }
  return {
    text: `${sections.join('\n\n----------------------------------------\n\n')}\n`,
    wheels: inventory,
  };
}
