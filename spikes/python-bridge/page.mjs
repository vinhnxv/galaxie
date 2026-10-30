// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only
import { exercise } from './host.mjs';

globalThis.result = exercise(
  new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' }),
  location.origin,
);
