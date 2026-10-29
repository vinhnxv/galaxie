// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Keep literal address classification aligned with core/urls.ts. Models cannot depend on core.
export function isLocalEndpoint(url: URL): boolean {
  const hostname = url.hostname;
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return true;
  if (/\.local\.?$/i.test(hostname)) return true;
  if (/^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(hostname)) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const parts = hostname.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [first, second = 0] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}
