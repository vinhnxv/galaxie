// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Evaluated first, so violations raised while the bundle itself loads are recorded too.
const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(
    `${event.violatedDirective}|${event.blockedURI}|${event.sample}|${event.lineNumber}:${event.columnNumber}`,
  );
});
Reflect.set(globalThis, 'adkViolations', violations);
