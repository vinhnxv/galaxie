// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { buildGoWasm } from '../../../../scripts/build-go-wasm.ts';
import { fetchGoGlue } from '../../../../scripts/fetch-go-glue.ts';
import { goInstalled } from '../../../../scripts/go-wasm-lock.ts';

const example = fileURLToPath(new URL('../../', import.meta.url));
const recipeDirectory = fileURLToPath(
  new URL('../../../../go/recipes/financial/', import.meta.url),
);

export function goAssets(): Plugin {
  let building = false;
  let wasm: { url: string; bytes: number; sha256: string } | undefined;
  const assets: { fileName: string; source: Uint8Array }[] = [];
  return {
    name: 'adk-recipes-go-assets',
    configResolved(config) {
      building = config.command === 'build';
    },
    async buildStart() {
      wasm = undefined;
      assets.length = 0;
      if (!building) return;
      if (!existsSync(recipeDirectory) || !goInstalled()) return;
      // The scaffold never fetches modules or a toolchain, even if the Go cache is incomplete.
      const previousProxy = process.env['GOPROXY'];
      const previousSumdb = process.env['GOSUMDB'];
      process.env['GOPROXY'] = 'off';
      process.env['GOSUMDB'] = 'off';
      try {
        const built = await buildGoWasm(
          './recipes/financial',
          join(example, '.cache/financial.wasm'),
        );
        const glue = await fetchGoGlue(undefined, join(example, '.cache'));
        assets.push({ fileName: 'go/financial.wasm', source: readFileSync(built.file) });
        assets.push({ fileName: 'go/wasm_exec.js', source: readFileSync(glue) });
        wasm = { url: '/go/financial.wasm', bytes: built.bytes, sha256: built.sha256 };
      } finally {
        if (previousProxy === undefined) delete process.env['GOPROXY'];
        else process.env['GOPROXY'] = previousProxy;
        if (previousSumdb === undefined) delete process.env['GOSUMDB'];
        else process.env['GOSUMDB'] = previousSumdb;
      }
    },
    resolveId(id) {
      return id === 'virtual:adk-recipes-go' ? '\0adk-recipes-go' : undefined;
    },
    load(id) {
      if (id !== '\0adk-recipes-go') return undefined;
      return `export const goBuild = ${JSON.stringify({ available: wasm !== undefined, wasm: wasm ?? null, glueUrl: wasm === undefined ? null : '/go/wasm_exec.js' })};`;
    },
    generateBundle() {
      for (const asset of assets) this.emitFile({ type: 'asset', ...asset });
    },
  };
}
