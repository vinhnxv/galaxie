// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Keep literal address classification aligned with core/urls.ts. Models cannot depend on core.
export function isLocalEndpoint(url: URL): boolean {
  let hostname = url.hostname;
  const mapped = /^\[::ffff:([\da-f]{1,4}):([\da-f]{1,4})\]$/i.exec(hostname);
  if (mapped !== null) {
    const [high = 0, low = 0] = mapped.slice(1).map((word) => Number.parseInt(word, 16));
    hostname = [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  }
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
