// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { PendingSurface } from '@galaxie-ai/core';
import { type ReactElement, useEffect, useState } from 'react';

/** Object order is immaterial; array order and every component property are material. */
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}

export function SurfaceChanges({
  surface,
}: {
  readonly surface: PendingSurface | undefined;
}): ReactElement {
  const [previous, setPrevious] = useState(surface);
  const [notice, setNotice] = useState<number>();
  useEffect(() => {
    if (previous === surface) return;
    setPrevious(surface);
    setNotice(
      previous !== undefined &&
        surface !== undefined &&
        previous.revision !== surface.revision &&
        !equal(previous.components, surface.components)
        ? surface.revision
        : undefined,
    );
  }, [previous, surface]);
  return (
    <p role="status" aria-live="polite" aria-atomic="true">
      {notice === undefined ? null : <span key={notice}>This step changed.</span>}
    </p>
  );
}
