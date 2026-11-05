// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The glue file is copied into the git-ignored cache by `scripts/fetch-go-glue.ts` after its digest
// matches the lock, so a clean checkout type-checks before the copy exists.
declare module '*/wasm_exec.js';
