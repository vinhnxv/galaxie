// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

declare module 'virtual:galaxie-python' {
  export const pythonBuild: {
    readonly localWheels: readonly import('@galaxie-ai/adapter-pyodide/runtime-files').LockedWheel[];
    readonly agentFiles: readonly string[];
    readonly sourceSha256: string;
    readonly runtimeUrl: string;
    readonly wheelsUrl: string;
    readonly agentUrl: string;
  };
}
