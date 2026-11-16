// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LockedWheel } from '@galaxie-ai/adapter-pyodide/runtime-files';
import type { Plugin, UserConfig } from 'vite';

interface PythonBuild {
  readonly localWheels: readonly LockedWheel[];
  readonly agentFiles: readonly string[];
  readonly sourceSha256: string;
}
interface Asset {
  readonly fileName: string;
  readonly source: Uint8Array;
}

export function pythonFramework(projectDirectory: string): UserConfig {
  let resolved: Promise<{ build: PythonBuild; assets: readonly Asset[] }> | undefined;
  async function resolveBuild(): Promise<{ build: PythonBuild; assets: readonly Asset[] }> {
    if (resolved !== undefined) return resolved;
    resolved = (async () => {
      // Resolve lazily so the generated baseline check needs no private artifacts installed.
      const require = createRequire(join(projectDirectory, 'package.json'));
      const entry = require.resolve('@galaxie-ai/starter-python/build');
      const { readManifest, verifyArtifact, invalidWheel } = (await import(
        pathToFileURL(entry).href
      )) as typeof import('@galaxie-ai/starter-python/build');
      const { lockedWheels, runtimeFiles } = (await import(
        pathToFileURL(require.resolve('@galaxie-ai/adapter-pyodide/runtime-files')).href
      )) as typeof import('@galaxie-ai/adapter-pyodide/runtime-files');
      const dist = dirname(entry);
      const manifest = await readManifest(dist);
      const assets: Asset[] = [];
      const add = async (
        fileName: string,
        path: string,
        expected: { readonly bytes: number; readonly sha256: string },
      ): Promise<void> => {
        await verifyArtifact(path, expected);
        assets.push({ fileName, source: await readFile(path) });
      };
      const required = lockedWheels.filter(
        (wheel) => wheel.frameworks === undefined || wheel.frameworks.includes('langgraph'),
      );
      for (const wheel of required) {
        const packed = manifest.wheels.find((item) => item.file === wheel.file);
        if (
          packed === undefined ||
          packed.bytes !== wheel.bytes ||
          packed.sha256 !== wheel.sha256 ||
          packed.name !== wheel.name ||
          packed.version !== wheel.version
        )
          throw new Error(invalidWheel(wheel.file));
      }
      const localWheels = manifest.wheels.filter(
        (wheel) => !required.some((item) => item.file === wheel.file),
      );
      if (
        localWheels.length !== 2 ||
        localWheels
          .map((wheel) => wheel.name)
          .sort()
          .join(',') !== 'galaxie,ormsgpack'
      )
        throw new Error('The Python starter wheel inventory is invalid.');
      for (const wheel of manifest.wheels)
        await add(`python/wheels/${wheel.file}`, join(dist, 'wheels', wheel.file), wheel);
      const pyodideVersion = '314.0.7';
      const runtime = dirname(require.resolve('pyodide/package.json'));
      const pkg = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')) as {
        version: string;
      };
      if (
        manifest.pyodideVersion !== pyodideVersion ||
        pkg.version !== pyodideVersion ||
        manifest.runtimeFiles.length !== runtimeFiles.length
      )
        throw new Error('The Python runtime inventory is invalid.');
      for (const file of runtimeFiles) {
        const packed = manifest.runtimeFiles.find((item) => item.file === file.file);
        if (packed === undefined || packed.bytes !== file.bytes)
          throw new Error(`The Python runtime file is invalid: ${file.file}.`);
        await add(`python/runtime/${file.file}`, join(runtime, file.file), packed);
      }
      await add('python/NOTICE.txt', join(dist, 'NOTICE.txt'), manifest.notices);
      const agentFiles: string[] = [];
      const hash = createHash('sha256');
      const root = join(projectDirectory, 'python/agent');
      const scan = async (directory: string, prefix = ''): Promise<void> => {
        if (!(await lstat(directory)).isDirectory())
          throw new Error(
            `The Python source path is not a regular directory: ${prefix || 'python/agent'}.`,
          );
        for (const name of (await readdir(directory)).sort()) {
          if (['.git', '.DS_Store', 'node_modules', '__pycache__'].includes(name)) continue;
          const path = join(directory, name);
          const relative = prefix + name;
          const info = await lstat(path);
          if (info.isDirectory()) await scan(path, `${relative}/`);
          else {
            if (!info.isFile())
              throw new Error(`The Python source path is not a regular file: ${relative}.`);
            const source = await readFile(path);
            // Frame every authored input, including hidden and underscore-prefixed paths.
            hash.update(JSON.stringify([relative, source.byteLength]));
            hash.update(source);
            if (!/\.(?:py|json)$/.test(relative)) continue;
            // Keep this rule identical to the installed adapter's source-path contract.
            if (
              !/^(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*\.(?:py|json)$/.test(relative)
            )
              throw new Error(`The Python source path is invalid: ${relative}.`);
            agentFiles.push(relative);
            assets.push({ fileName: `python/agent/${relative}`, source });
          }
        }
      };
      await scan(root);
      return {
        build: {
          localWheels: localWheels.map(({ name, version, file, bytes, sha256 }) => ({
            name,
            version,
            file,
            bytes,
            sha256,
          })),
          agentFiles,
          sourceSha256: hash.digest('hex'),
        },
        assets,
      };
    })();
    return resolved;
  }
  const assets: Plugin = {
    name: 'galaxie-python-assets',
    async buildStart() {
      resolved = undefined;
      const result = await resolveBuild();
      for (const asset of result.assets) this.emitFile({ type: 'asset', ...asset });
    },
    transform(code, id) {
      if (id === join(projectDirectory, 'src/main.tsx'))
        return `import 'virtual:galaxie-python-env';\n${code}`;
      return undefined;
    },
    resolveId(id) {
      if (id === 'virtual:galaxie-python-env') return '\0galaxie-python-env';
      return id === 'virtual:galaxie-python' ? '\0galaxie-python' : undefined;
    },
    async load(id) {
      if (id === '\0galaxie-python-env')
        return "import { z } from 'zod'; z.config({ jitless: true });";
      if (id !== '\0galaxie-python') return undefined;
      const { build } = await resolveBuild();
      return `export const pythonBuild = { ...${JSON.stringify(build)}, runtimeUrl: import.meta.env.BASE_URL + 'python/runtime/', wheelsUrl: import.meta.env.BASE_URL + 'python/wheels/', agentUrl: import.meta.env.BASE_URL + 'python/agent/' };`;
    },
  };
  return { plugins: [assets] };
}
const config: UserConfig = pythonFramework(fileURLToPath(new URL('.', import.meta.url)));
export default config;
