// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

declare module 'virtual:rag-python' {
  export const pythonBuild: {
    readonly available: boolean;
    readonly bytes: Readonly<Record<'langgraph' | 'pydantic-ai' | 'dspy' | 'adk', number>>;
    readonly localWheels: readonly {
      readonly name: string;
      readonly version: string;
      readonly file: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
  };
}
