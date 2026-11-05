// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
import { exercise } from './host.mjs';

globalThis.result = exercise(
  new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }),
  location.origin,
);
