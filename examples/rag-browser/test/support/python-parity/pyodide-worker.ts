// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '@galaxie-ai/adapter-pyodide/worker';

// The adapter only boots Python after a message, after this module has installed its listener.
addEventListener('securitypolicyviolation', (event) =>
  globalThis.postMessage(
    JSON.stringify({ type: 'violation', directive: event.effectiveDirective }),
  ),
);
