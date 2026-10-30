// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import '@galaxie/adapter-pyodide/worker';

// The adapter only boots Python after a message, after this module has installed its listener.
addEventListener('securitypolicyviolation', (event) =>
  globalThis.postMessage(
    JSON.stringify({ type: 'violation', directive: event.effectiveDirective }),
  ),
);
