// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import '../../../../../packages/adapter-pyodide/src/worker.js';

addEventListener('securitypolicyviolation', (event) =>
  globalThis.postMessage(
    JSON.stringify({ type: 'violation', directive: event.effectiveDirective }),
  ),
);
