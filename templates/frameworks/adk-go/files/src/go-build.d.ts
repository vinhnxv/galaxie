// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

declare module 'virtual:galaxie-go' {
  export const goBuild: {
    readonly origin: 'cache' | 'prebuilt' | 'local';
    readonly sourceSha256: string;
    readonly wasm: { readonly url: string; readonly bytes: number; readonly sha256: string };
  };
}
declare module 'virtual:galaxie-go-glue' {}
