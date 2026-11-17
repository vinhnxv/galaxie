// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { lockedWheels, runtimeFiles } from '../../packages/adapter-pyodide/src/runtime-files.js';
import { collectNotices } from '../../packages/starter-python/src/notices.js';
import {
  fileMetadata,
  verifyArtifact,
  verifyDist,
} from '../../packages/starter-python/src/verify.js';
import { buildStarterDist } from '../../scripts/build-starter-python.js';
import {
  buildStarterDistOnce,
  cleanStarterDist,
  hasStarterPython,
} from './support/starter-python.node.js';

const available = hasStarterPython();
const cache = resolve('.cache/python-wheels');
const selected = lockedWheels.filter(
  (wheel) => !wheel.frameworks || wheel.frameworks.includes('langgraph'),
);
const require = createRequire(resolve('packages/starter-python/package.json'));
const { zipSync, unzipSync } = require('fflate') as {
  zipSync: (entries: Record<string, Uint8Array>) => Uint8Array;
  unzipSync: (bytes: Uint8Array) => Record<string, Uint8Array>;
};
const temporary: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-starter-python-proof-'));
  temporary.push(directory);
  return directory;
}
afterAll(async () => {
  await cleanStarterDist();
  await Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true })));
});

test.each(['bytes', 'sha256'] as const)(
  'artifact verification independently checks %s',
  async (field) => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'sample.whl');
    await writeFile(file, 'original');
    const expected = { ...(await fileMetadata(file)) };
    if (field === 'bytes') expected.bytes += 1;
    else await writeFile(file, 'tampered');
    await expect(verifyArtifact(file, expected)).rejects.toThrow(
      'The Python starter wheel could not be verified: sample.whl.',
    );
  },
);

test.skipIf(!available)(
  'packs exactly the adapter LangGraph lane plus both local wheels',
  async () => {
    const built = await buildStarterDistOnce();
    const local = JSON.parse(await readFile(join(cache, 'local-wheels.json'), 'utf8')) as {
      packages: { file: string; bytes: number; sha256: string }[];
    };
    const expected = [...selected, ...local.packages];
    expect(built.manifest.wheels.map((wheel) => wheel.file).sort()).toEqual(
      expected.map((wheel) => wheel.file).sort(),
    );
    expect(built.manifest.wheels.some((wheel) => wheel.name === 'cryptography')).toBe(false);
    expect(built.manifest.wheels).toHaveLength(selected.length + 2);
    expect(built.manifest.wheels.reduce((sum, wheel) => sum + wheel.bytes, 0)).toBe(
      expected.reduce((sum, wheel) => sum + wheel.bytes, 0),
    );
    expect((await readdir(join(built.directory, 'dist/wheels'))).sort()).toEqual(
      expected.map((wheel) => wheel.file).sort(),
    );
    for (const wheel of expected) {
      expect(await fileMetadata(join(built.directory, 'dist/wheels', wheel.file))).toEqual({
        bytes: wheel.bytes,
        sha256: wheel.sha256,
      });
    }
    expect(await verifyDist(built.directory, built.manifest)).toEqual(built.manifest);
    const again = await buildStarterDist(built.directory);
    expect(again).toEqual(built.manifest);
  },
);

test.skipIf(!available)('records the pinned npm runtime lengths and SHA-256 hashes', async () => {
  const { manifest } = await buildStarterDistOnce();
  const pyodide = dirname(
    createRequire(resolve('packages/adapter-pyodide/package.json')).resolve('pyodide/package.json'),
  );
  const pkg = JSON.parse(await readFile(join(pyodide, 'package.json'), 'utf8')) as {
    version: string;
  };
  expect(manifest.pyodideVersion).toBe('314.0.7');
  expect(manifest.pyodideVersion).toBe(pkg.version);
  expect(manifest.runtimeFiles.map(({ file, bytes }) => ({ file, bytes }))).toEqual(runtimeFiles);
  for (const runtime of manifest.runtimeFiles) {
    const bytes = await readFile(join(pyodide, runtime.file));
    expect(runtime.bytes).toBe(bytes.byteLength);
    expect(runtime.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  }
});

test.skipIf(!available).each(['changed', 'truncated', 'missing'] as const)(
  'pack names a %s wheel without repairing the cache or retaining a manifest',
  async (mutation) => {
    const built = await buildStarterDistOnce();
    const directory = await temporaryDirectory();
    const pkg = join(directory, 'package');
    await cp(built.directory, pkg, { recursive: true, dereference: false });
    const wheelCache = join(directory, 'cache');
    await mkdir(wheelCache);
    const wheel = selected[0];
    if (!wheel) throw new Error('Missing locked wheel.');
    const bytes = await readFile(join(cache, wheel.file));
    if (mutation === 'changed') bytes[0] = (bytes[0] ?? 0) ^ 1;
    const altered = mutation === 'truncated' ? bytes.subarray(0, 5) : bytes;
    if (mutation !== 'missing') await writeFile(join(wheelCache, wheel.file), altered);
    await expect(buildStarterDist(pkg, { wheelCache })).rejects.toThrow(
      `The Python starter wheel could not be verified: ${wheel.file}.`,
    );
    await expect(readFile(join(pkg, 'dist/manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    if (mutation !== 'missing')
      expect(await readFile(join(wheelCache, wheel.file))).toEqual(altered);
    else
      await expect(readFile(join(wheelCache, wheel.file))).rejects.toMatchObject({
        code: 'ENOENT',
      });
  },
);

test.skipIf(!available).each(['manifest', 'wheel', 'symlink', 'notice'] as const)(
  'release verification refuses an edited %s',
  async (mutation) => {
    const built = await buildStarterDistOnce();
    const directory = await temporaryDirectory();
    await cp(built.directory, directory, { recursive: true, dereference: false });
    const wheel = built.manifest.wheels[0];
    if (!wheel) throw new Error('Missing packed wheel.');
    const path = join(directory, 'dist/wheels', wheel.file);
    if (mutation === 'manifest') {
      await writeFile(
        join(directory, 'dist/manifest.json'),
        JSON.stringify({ ...built.manifest, pyodideVersion: '0.0.0' }),
      );
    } else if (mutation === 'notice') {
      await writeFile(join(directory, 'dist/NOTICE.txt'), 'changed');
    } else if (mutation === 'symlink') {
      await rm(path);
      await symlink(join(built.directory, 'dist/wheels', wheel.file), path);
    } else {
      const bytes = await readFile(path);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await writeFile(path, bytes);
    }
    await expect(verifyDist(directory, built.manifest)).rejects.toThrow('could not be verified');
  },
);

test.skipIf(!available).each(['missing', 'changed', 'license'] as const)(
  'pack checks a local wheel against its cache inventory: %s',
  async (mutation) => {
    const built = await buildStarterDistOnce();
    const directory = await temporaryDirectory();
    const pkg = join(directory, 'package');
    await cp(built.directory, pkg, { recursive: true, dereference: false });
    const wheelCache = join(directory, 'cache');
    await mkdir(wheelCache);
    const local = JSON.parse(await readFile(join(cache, 'local-wheels.json'), 'utf8')) as {
      packages: { name: string; version: string; file: string; bytes: number; sha256: string }[];
    };
    for (const wheel of [...selected, ...local.packages])
      await cp(join(cache, wheel.file), join(wheelCache, wheel.file));
    const wheel = local.packages.find((entry) => entry.name === 'galaxie');
    if (!wheel) throw new Error('Missing local wheel.');
    const path = join(wheelCache, wheel.file);
    if (mutation === 'missing') await rm(path);
    else if (mutation === 'changed') {
      const bytes = await readFile(path);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      await writeFile(path, bytes);
    } else {
      // Keep name/version consistent so the license policy is the rejecting boundary.
      const synthetic = zipSync({
        'galaxie-0.0.0.dist-info/METADATA': Buffer.from(
          'Metadata-Version: 2.4\nName: galaxie\nVersion: 0.0.0\nLicense-Expression: GPL-3.0-only\n\n',
        ),
        'galaxie-0.0.0.dist-info/licenses/LICENSE': Buffer.from(
          'Synthetic unapproved license text.',
        ),
      });
      await writeFile(path, synthetic);
      wheel.bytes = synthetic.byteLength;
      wheel.sha256 = createHash('sha256').update(synthetic).digest('hex');
    }
    await writeFile(
      join(wheelCache, 'local-wheels.json'),
      JSON.stringify({ v: 'galaxie.python-build/v1', packages: local.packages }),
    );
    await expect(buildStarterDist(pkg, { wheelCache })).rejects.toThrow(
      mutation === 'license'
        ? `The Python wheel license is not allowed or is missing: ${wheel.file}.`
        : `The Python starter wheel could not be verified: ${wheel.file}.`,
    );
    await expect(readFile(join(pkg, 'dist/manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

test.skipIf(!available).each(['changed', 'missing', 'extra'] as const)(
  'pack refuses a cached galaxie wheel with %s Python sources even when its inventory agrees',
  async (mutation) => {
    const built = await buildStarterDistOnce();
    const directory = await temporaryDirectory();
    const pkg = join(directory, 'package');
    await cp(built.directory, pkg, { recursive: true, dereference: false });
    const wheelCache = join(directory, 'cache');
    await mkdir(wheelCache);
    const local = JSON.parse(await readFile(join(cache, 'local-wheels.json'), 'utf8')) as {
      packages: { name: string; file: string; bytes: number; sha256: string }[];
    };
    for (const wheel of [...selected, ...local.packages])
      await cp(join(cache, wheel.file), join(wheelCache, wheel.file));
    const wheel = local.packages.find((item) => item.name === 'galaxie');
    if (!wheel) throw new Error('The galaxie wheel is missing.');
    const path = join(wheelCache, wheel.file);
    const entries = unzipSync(await readFile(path));
    const source = 'galaxie/_bridge.py';
    if (mutation === 'missing') delete entries[source];
    else if (mutation === 'extra') entries['galaxie/removed.py'] = Buffer.from('# Stale module.\n');
    else entries[source] = Buffer.from('# Stale source.\n');
    const bytes = zipSync(entries);
    await writeFile(path, bytes);
    wheel.bytes = bytes.byteLength;
    wheel.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(
      join(wheelCache, 'local-wheels.json'),
      JSON.stringify({ v: 'galaxie.python-build/v1', packages: local.packages }),
    );
    await expect(buildStarterDist(pkg, { wheelCache })).rejects.toThrow(
      `The Python starter wheel does not match python/galaxie/src: ${wheel.file}. Rebuild with: node scripts/build-python-wheels.ts`,
    );
    await expect(readFile(join(pkg, 'dist/manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  },
);

const permissive = (
  JSON.parse(await readFile('scripts/dependency-license-allowlist.json', 'utf8')) as {
    permissive: string[];
  }
).permissive;
function syntheticWheel(
  license: string,
  name = 'sample',
): { name: string; version: string; file: string; bytes: Uint8Array } {
  const directory = `${name}-1.0.dist-info`;
  return {
    name,
    version: '1.0',
    file: `${name}-1.0-py3-none-any.whl`,
    bytes: zipSync({
      [`${directory}/METADATA`]: Buffer.from(
        `Metadata-Version: 2.4\nName: ${name}\nVersion: 1.0\nLicense-Expression: ${license}\nLicense-File: LICENSE\n\n`,
      ),
      [`${directory}/licenses/LICENSE`]: Buffer.from('Synthetic license text for policy tests.'),
      ...(name === 'orjson'
        ? {
            [`${directory}/licenses/LICENSE-MPL-2.0`]: Buffer.from(
              'Synthetic MPL text for policy tests.',
            ),
          }
        : {}),
    }),
  };
}

test.each([...permissive, 'Apache-2.0 OR BSD-2-Clause'])(
  'notices admit the explicit permissive policy: %s',
  (license) => {
    expect(
      collectNotices([syntheticWheel(license)], { permissive, repositoryLicense: 'Local license' })
        .wheels[0]?.license,
    ).toBe(license);
  },
);
test.each(['UNKNOWN', 'UNLICENSED', 'GPL-3.0-only', 'MIT OR UNKNOWN', 'MPL-2.0', 'PSF-2.0'])(
  'notices refuse unapproved license %s',
  (license) => {
    expect(() =>
      collectNotices([syntheticWheel(license)], { permissive, repositoryLicense: 'Local license' }),
    ).toThrow('license');
  },
);
test.each([
  ['certifi', 'MPL-2.0'],
  ['orjson', 'MPL-2.0 AND (Apache-2.0 OR MIT)'],
  ['typing-extensions', 'PSF-2.0'],
])('notices admit the named exception for %s', (name, license) => {
  expect(
    collectNotices([syntheticWheel(license, name)], {
      permissive,
      repositoryLicense: 'Local license',
    }).wheels[0]?.license,
  ).toBe(license);
});
test.skipIf(!available)(
  'notices preserve license texts and flag MPL and the limited ormsgpack stand-in',
  async () => {
    const built = await buildStarterDistOnce();
    const notice = await readFile(join(built.directory, 'dist/NOTICE.txt'), 'utf8');
    for (const wheel of built.manifest.wheels) {
      expect(notice).toContain(`${wheel.name}@${wheel.version}`);
      const archive = unzipSync(await readFile(join(cache, wheel.file)));
      const licenses = Object.entries(archive).filter(([path]) =>
        /\.dist-info\/(?:licenses\/|(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS))/i.test(path),
      );
      if (!['galaxie', 'ormsgpack'].includes(wheel.name))
        expect(licenses.length, wheel.file).toBeGreaterThan(0);
      for (const [path, bytes] of licenses) {
        expect(notice, path).toContain(path);
        expect(notice, path).toContain(Buffer.from(bytes).toString('utf8'));
      }
    }
    expect(notice).toContain(await readFile('LICENSE', 'utf8'));
    expect(notice).toContain('certifi: MPL-2.0');
    expect(notice).toContain('orjson: MPL-2.0');
    expect(notice).toContain('LICENSE-MPL-2.0');
    expect(notice).toContain('Mozilla Public License Version 2.0');
    expect(notice).toContain('license to be confirmed by the maintainer');
    expect(notice).toContain('limited same-name stand-in, not upstream');
    expect(notice).toContain(
      'Its source header describes it as independently written and says no upstream implementation is included.',
    );
    expect(notice).toContain('serializer compatibility is unverified');
  },
);
