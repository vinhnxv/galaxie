// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export function cspHeader(): string {
  return "default-src 'none'; script-src 'self'; worker-src 'none'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
}
