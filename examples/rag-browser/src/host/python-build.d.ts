// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

declare module 'virtual:rag-python' {
  export const pythonBuild: {
    readonly available: boolean;
    readonly bytes: Readonly<Record<'langgraph' | 'pydantic-ai', number>>;
    readonly localWheels: readonly {
      readonly name: string;
      readonly version: string;
      readonly file: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
  };
}
