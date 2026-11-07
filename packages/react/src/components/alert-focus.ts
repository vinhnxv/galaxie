// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type RefObject, useEffect, useRef } from 'react';

/** Focus once on each transition into an alert, optionally including its initial mount. */
export function useAlertFocus(
  active: boolean,
  focusOnMount = false,
): RefObject<HTMLParagraphElement | null> {
  const wasActive = useRef(active && !focusOnMount);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (active && !wasActive.current) alert.current?.focus();
    wasActive.current = active;
  }, [active]);
  return alert;
}
