// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '@galaxie-ai/adapter-pyodide/worker';

// Pyodide leaves startup pending after a CSP-denied instantiation. Fail before boot messages.
new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
