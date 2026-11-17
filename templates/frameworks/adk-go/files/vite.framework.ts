// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArtifactMetadata, ResolvedAgent } from '@galaxie-ai/starter-go/build';
import type { Plugin, UserConfig } from 'vite';

export function goFramework(projectDirectory: string): UserConfig {
  let resolved: Promise<ResolvedAgent> | undefined;

  async function readVerified(file: string, expected: ArtifactMetadata): Promise<Buffer> {
    // Hash the exact bytes that are emitted, as in the Python starter's asset helper.
    const source = await readFile(file).catch(() => undefined);
    if (
      source === undefined ||
      source.byteLength !== expected.bytes ||
      createHash('sha256').update(source).digest('hex') !== expected.sha256
    )
      throw new Error(`The Go starter file could not be verified: ${file}.`);
    return source;
  }

  async function resolveBuild(): Promise<ResolvedAgent> {
    // Configuration and baseline checks load without the artifact package installed.
    if (resolved !== undefined) return resolved;
    const entry = createRequire(join(projectDirectory, 'package.json')).resolve(
      '@galaxie-ai/starter-go/build',
    );
    const { resolveAgent } = (await import(
      pathToFileURL(entry).href
    )) as typeof import('@galaxie-ai/starter-go/build');
    resolved = resolveAgent({ projectDirectory });
    return resolved;
  }

  function goGlue(): Plugin {
    return {
      name: 'galaxie-go-glue',
      resolveId(id) {
        return id === 'virtual:galaxie-go-glue' ? '\0galaxie-go-glue' : undefined;
      },
      async load(id) {
        if (id !== '\0galaxie-go-glue') return undefined;
        const built = await resolveBuild();
        return (await readVerified(built.glue.file, built.glue)).toString('utf8');
      },
    };
  }

  function goAssets(): Plugin {
    let building = false;
    return {
      name: 'galaxie-go-assets',
      configResolved(config) {
        building = config.command === 'build';
      },
      async buildStart() {
        if (!building) return;
        resolved = undefined;
        const built = await resolveBuild();
        this.emitFile({
          type: 'asset',
          fileName: 'go/agent.wasm',
          source: await readVerified(built.file, built.wasm),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'go/NOTICE.txt',
          source: await readVerified(built.notices.file, built.notices),
        });
      },
      transform(code, id) {
        if (id === join(projectDirectory, 'src/main.tsx'))
          return `import 'virtual:galaxie-go-env';\n${code}`;
        return undefined;
      },
      resolveId(id) {
        if (id === 'virtual:galaxie-go-env') return '\0galaxie-go-env';
        return id === 'virtual:galaxie-go' ? '\0galaxie-go' : undefined;
      },
      async load(id) {
        // Initialize Zod before page dependencies create schemas and probe eval support.
        if (id === '\0galaxie-go-env')
          return "import { z } from 'zod'; z.config({ jitless: true });";
        if (id !== '\0galaxie-go') return undefined;
        const { origin, sourceSha256, wasm } = await resolveBuild();
        return `export const goBuild = { ...${JSON.stringify({ origin, sourceSha256, wasm })}, wasm: { ...${JSON.stringify(wasm)}, url: import.meta.env.BASE_URL + 'go/agent.wasm' } };`;
      },
    };
  }

  return {
    plugins: [goAssets(), goGlue()],
    worker: { plugins: () => [goGlue()] },
  };
}
const config: UserConfig = goFramework(fileURLToPath(new URL('.', import.meta.url)));
export default config;
