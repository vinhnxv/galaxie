// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

declare module 'virtual:adk-recipes-go-glue';

declare module 'virtual:adk-recipes-python' {
  export const pythonBuild: {
    readonly available: boolean;
    readonly bytes: number;
    readonly localWheels: readonly import('../../../../packages/adapter-pyodide/src/runtime-files.js').LockedWheel[];
  };
}
declare module 'virtual:adk-recipes-go' {
  export const goBuild: {
    readonly available: boolean;
    readonly wasm: { readonly url: string; readonly bytes: number; readonly sha256: string } | null;
    readonly glueUrl: string | null;
  };
}
